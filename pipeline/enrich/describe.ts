import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Entry } from '@hub/contracts';
import { buildFacts } from './facts';
import { fallbackDescription } from './fallback-prose';
import { FallbackTracker } from './fallback-tracker';
import { invokeOmp, type SpawnOmpOptions } from './describe-spawn';
import { resolveEnrichmentModel } from './antigravity-proxy';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import {
  buildEnrichmentIdentity,
  isCheckpointCompatible,
  MODEL_INPUT_SANITIZER_VERSION,
  DESCRIPTION_SCHEMA_VERSION,
  type EnrichmentIdentity,
} from './enrichment-identity';
import { buildDescriptionEvidence } from './description-evidence';
import { renderGeneratedDescription, validateGeneratedDescription } from './description-contract';
import { safeRejectionReason, writeEnrichmentRejections, type EnrichmentRejection } from './enrichment-rejection';
import { buildDescriptionProvenance } from './provenance';
import { isValidGeneratedContent } from './checkpoint-validity';

// `systemPromptPath` is required when spawning, but `describeEntries` resolves a
// default before it spawns, so callers may omit it.
export type DescribeOptions = Partial<SpawnOmpOptions> & {
  /** Sanitized n8n workflow JSON keyed by catalogue id; no derived facts are accepted. */
  workflowsById?: ReadonlyMap<string, unknown>;
  checkpointPath?: string;
  concurrency?: number;
  batchSize?: number;
  maxRetries?: number;
  fallbackWindowSize?: number;
  maxFallbackRate?: number;
  /** Re-attempt entries whose checkpoint records a fallback. */
  retryFallbacks?: boolean;
  /** Replace valid upstream prose through the model; disabled unless explicit. */
  regenerateUpstream?: boolean;
  /** Stable prompt identifier recorded with generated prose. */
  promptVersion?: string;
  /** Timestamp for generated/fallback descriptions; injected for deterministic tests. */
  generatedAt?: string;
  sanitizerVersion?: string;
  schemaVersion?: string;
  /** Production mode: unresolved Gemini output is a rejection, never fallback prose. */
  requireGemini?: boolean;
};

export type DescribedEntry = Entry & {
  summary: string;
  description: string;
  descriptionSource: 'upstream' | 'generated' | 'fallback';
};

export type DescribeStats = {
  total: number;
  passedFirstTry: number;
  neededRetry: number;
  fellBack: number;
  wallClockMs: number;
  exampleDescriptions: Array<{ id: string; summary: string; description: string }>;
};

export type DescribeResult = {
  entries: DescribedEntry[];
  stats: DescribeStats;
  rejections: EnrichmentRejection[];
};

export const DEFAULT_PROMPT_VERSION = 'describe-6-json-workflow-lexical-check';

const MODEL_RETRY_CORRECTION = [
  'Revision correction: replace the complete previous JSON array and run the final lexical check again.',
  'Do not place timing or cost words, security verdicts, licence names, links, or operational promise language in any returned field, including the hypothetical example. If a visible node label contains a token that could also be a licence identifier (for example MIT), describe the node by its role or node type instead of repeating that token.',
  'Use neutral descriptions of visible nodes and handoffs; name a service only when its exact name or node type is visible in this workflow (Google Sheets is not Google Drive). Return exactly one complete object per input workflow in the original order.',
].join(' ');

/**
 * Whether an upstream description is a generated template rather than writing.
 *
 * The aggregator repositories synthesise a line per file, so 1,744 of the 1,765
 * "upstream" descriptions in the first production corpus opened with
 * "Automated workflow: <filename>. This workflow processes data and performs
 * automated tasks." Trusting those published thousands of near-identical pages,
 * which is thin content for a reader and for a crawler. They are treated as
 * absent so the entry earns a real description instead.
 */
const TEMPLATE_OPENERS =
  /^(?:automated|production-ready|comprehensive|simple|complex)?\s*(?:n8n\s*)?workflow\s*[:\-]/i;
const TEMPLATE_FILLER = /this workflow (?:processes data and )?performs automated tasks/i;

export function isTemplateProse(description: string): boolean {
  const text = description.trim();
  return TEMPLATE_OPENERS.test(text) || TEMPLATE_FILLER.test(text);
}

export async function describeEntries(
  entries: Entry[],
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  const startTime = Date.now();
  const batchSize = options.batchSize ?? 5;
  const concurrency = options.concurrency ?? 4;
  const maxRetries = options.maxRetries ?? 2;
  const systemPromptPath =
    options.systemPromptPath ||
    path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt');
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const model = options.model ?? resolveEnrichmentModel();
  let promptText = '';
  try {
    promptText = fs.readFileSync(systemPromptPath, 'utf8');
  } catch {
    // A missing prompt will still produce a deterministic identity and fail at spawn time.
  }
  const identityFor = (entry: Entry): EnrichmentIdentity | undefined => {
    const workflow = options.workflowsById?.get(entry.id);
    if (workflow === undefined) return undefined;
    return buildEnrichmentIdentity(workflow, {
      promptText,
      promptVersion,
      model,
      sanitizerVersion: options.sanitizerVersion ?? MODEL_INPUT_SANITIZER_VERSION,
      schemaVersion: options.schemaVersion ?? DESCRIPTION_SCHEMA_VERSION,
    });
  };
  const provenanceFor = (source: 'gemini' | 'upstream' | 'fallback', entry?: Entry, at = generatedAt) =>
    buildDescriptionProvenance(source, { model, promptVersion, generatedAt: at, identity: entry ? identityFor(entry) : undefined });
  const tracker = new FallbackTracker(
    options.fallbackWindowSize ?? 200,
    options.maxFallbackRate ?? 0.05,
  );
  const checkpointMap = loadCheckpoint(options.checkpointPath);
  const resultMap = new Map<string, DescribedEntry>();
  const rejections: EnrichmentRejection[] = [];
  let passedFirstTry = 0;
  let neededRetry = 0;
  let fellBack = 0;
  /** Why the model's output was refused, so a bad run names its cause. */
  const rejectionReasons = new Map<string, number>();
  const lastRejectionReasons = new Map<string, string>();
  const checkpointIsCurrent = (entry: Entry, cp: ReturnType<typeof loadCheckpoint>[string]): boolean => {
    const identity = identityFor(entry);
    return identity !== undefined && isCheckpointCompatible(cp, identity);
  };
  const recordOutcome = (isFallback: boolean) => {
    try {
      tracker.record(isFallback);
    } catch (error) {
      const causes = [...rejectionReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${count}x ${reason}`)
        .join('; ');
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Refusal causes: ${causes || 'none recorded'}`,
      );
    }
  };
  // 1. Process upstream & checkpointed entries
  const toProcess: Entry[] = [];
  for (const entry of entries) {
    if (checkpointMap[entry.id] && checkpointIsCurrent(entry, checkpointMap[entry.id])) {
      const cp = checkpointMap[entry.id];
      // A cached give-up is retried only when the caller asks for it, so that a
      // resumed run is idempotent by default but a fixed model can be re-applied.
      if (cp.descriptionSource === 'fallback' && (options.retryFallbacks || options.requireGemini)) {
        toProcess.push(entry);
        continue;
      }
      if (cp.descriptionSource === 'upstream' && options.regenerateUpstream) { toProcess.push(entry); continue; }
      if (cp.descriptionSource === 'generated' && !isValidGeneratedContent(entry, cp, options.workflowsById?.get(entry.id))) { toProcess.push(entry); continue; }
      resultMap.set(entry.id, {
        ...entry,
        summary: cp.summary,
        description: cp.description,
        descriptionSource: cp.descriptionSource,
        ...(cp.descriptionContent ? { descriptionContent: cp.descriptionContent } : {}),
        descriptionProvenance: cp.descriptionSource === 'generated'
          ? provenanceFor('gemini', entry, cp.descriptionProvenance?.generatedAt ?? generatedAt)
          : cp.descriptionProvenance ?? provenanceFor(cp.descriptionSource),
      });
      checkpointMap[entry.id] = { ...cp, descriptionProvenance: resultMap.get(entry.id)!.descriptionProvenance };
      // Deliberately not recorded against the fallback tracker. The tracker is a
      // circuit breaker over live generation; replaying history through it means
      // any run that ever fell back can never resume, which is what happened.
      if (cp.descriptionSource === 'fallback') fellBack++;
      else if (cp.descriptionSource === 'generated') passedFirstTry++;
      continue;
    }

    if (
      !options.regenerateUpstream &&
      entry.descriptionSource === 'upstream' &&
      entry.description &&
      !isTemplateProse(entry.description)
    ) {
      resultMap.set(entry.id, {
        ...entry,
        summary: entry.summary || entry.description.slice(0, 100),
        description: entry.description,
        descriptionSource: 'upstream',
        descriptionProvenance: provenanceFor('upstream'),
      });
      checkpointMap[entry.id] = {
        summary: resultMap.get(entry.id)!.summary,
        description: entry.description,
        descriptionSource: 'upstream',
        descriptionProvenance: provenanceFor('upstream'),
        workflowFingerprint: entry.dedup.fingerprint,
        identity: identityFor(entry),
      };
      continue;
    }
    toProcess.push(entry);
  }
  saveCheckpoint(options.checkpointPath, checkpointMap);
  // 2. Chunk remaining entries into batches of 5
  const batches: Entry[][] = [];
  for (let i = 0; i < toProcess.length; i += batchSize) {
    batches.push(toProcess.slice(i, i + batchSize));
  }
  const processBatch = async (batchIndex: number, batch: Entry[]) => {
    console.log(`[Batch ${batchIndex + 1}/${batches.length}] Starting batch of ${batch.length} entries...`);
    let pending = [...batch];
    let attempt = 0;
    while (pending.length > 0 && attempt <= maxRetries) {
      const modelEntries = pending.filter((entry) => options.workflowsById?.has(entry.id));
      const missingWorkflowEntries = pending.filter((entry) => !options.workflowsById?.has(entry.id));
      const nextPending: Entry[] = [];
      for (const entry of missingWorkflowEntries) {
        const reason = 'no workflow JSON available for model input';
        rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);
        lastRejectionReasons.set(entry.id, reason);
        nextPending.push(entry);
      }

      const invocationGroups = attempt === 0 ? [modelEntries] : modelEntries.map((entry) => [entry]);
      for (const group of invocationGroups) {
        if (group.length === 0) continue;
        const res = await invokeOmp(group.map((entry) => options.workflowsById!.get(entry.id)), { systemPromptPath, promptHint: attempt > 0 ? MODEL_RETRY_CORRECTION : undefined, model: options.model, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, ompExe: options.ompExe, spawnFn: options.spawnFn, proxyBaseUrl: options.proxyBaseUrl, proxyApiKey: options.proxyApiKey, proxyModel: options.proxyModel, fetchFn: options.fetchFn });
        const auditedResponse = res.ok && res.data.length !== group.length
          ? { ok: false as const, error: `Model returned ${res.data.length} records for ${group.length} workflows` }
          : res;
        if (auditedResponse.ok) {
          for (let modelIndex = 0; modelIndex < group.length; modelIndex++) {
            const entry = group[modelIndex];
            const workflow = options.workflowsById!.get(entry.id);
            const item = auditedResponse.data[modelIndex];
            if (item) {
              const val = validateGeneratedDescription(item, buildDescriptionEvidence(workflow));
              if (val.valid) {
                const summary = val.value.summary;
                const description = renderGeneratedDescription(val.value);
                resultMap.set(entry.id, {
                  ...entry,
                  summary,
                  description,
                  descriptionSource: 'generated',
                  descriptionContent: val.value,
                  descriptionProvenance: provenanceFor('gemini', entry),
                });
                checkpointMap[entry.id] = {
                  summary,
                  description,
                  descriptionSource: 'generated',
                  descriptionContent: val.value,
                  descriptionProvenance: provenanceFor('gemini', entry),
                  workflowFingerprint: entry.dedup.fingerprint,
                  identity: identityFor(entry),
                };
                recordOutcome(false);
                if (attempt === 0) passedFirstTry++;
                else neededRetry++;
                continue;
              }
              console.warn(`[Batch ${batchIndex + 1}] structured description rejected: ${val.errors.join('; ')}`);
              const reason = val.errors.join(', ');
              lastRejectionReasons.set(entry.id, safeRejectionReason(reason));
              rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);
              nextPending.push(entry);
              continue;
            }
            nextPending.push(entry);
            lastRejectionReasons.set(entry.id, 'no entry in model response');
            rejectionReasons.set('no entry in model response', (rejectionReasons.get('no entry in model response') ?? 0) + 1);
          }
        } else {
          console.warn(`[Batch ${batchIndex + 1}] invokeOmp failed (attempt ${attempt + 1}/${maxRetries + 1}): ${auditedResponse.error}`);
          rejectionReasons.set(auditedResponse.error, (rejectionReasons.get(auditedResponse.error) ?? 0) + group.length);
          for (const entry of group) lastRejectionReasons.set(entry.id, safeRejectionReason(auditedResponse.error));
          nextPending.push(...group);
        }
      }

      pending = nextPending;
      attempt++;
    }

    for (const entry of pending) {
      if (options.requireGemini) {
        const detail = lastRejectionReasons.get(entry.id);
        const reason = detail
          ? `Gemini output remained invalid after retries: ${detail}`
          : 'Gemini output remained invalid after retries';
        rejections.push({ id: entry.id, reason });
        resultMap.set(entry.id, {
          ...entry,
          summary: '',
          description: '',
          descriptionSource: 'fallback',
          descriptionContent: undefined,
          descriptionProvenance: undefined,
        });
        delete checkpointMap[entry.id];
        continue;
      }
      const facts = buildFacts(entry);
      const fallback = fallbackDescription(facts);
      resultMap.set(entry.id, {
        ...entry,
        summary: fallback.summary,
        description: fallback.description,
        descriptionSource: 'fallback',
        descriptionContent: undefined,
        descriptionProvenance: provenanceFor('fallback'),
      });
      checkpointMap[entry.id] = {
        summary: fallback.summary,
        description: fallback.description,
        descriptionSource: 'fallback',
        descriptionProvenance: provenanceFor('fallback'),
        workflowFingerprint: entry.dedup.fingerprint,
        identity: identityFor(entry),
      };
      recordOutcome(true);
      fellBack++;
    }
    saveCheckpoint(options.checkpointPath, checkpointMap);
    console.log(`[Batch ${batchIndex + 1}/${batches.length}] Completed.`);
  };

  // 3. Process batches with concurrency pool
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    await Promise.all(chunk.map((b, idx) => processBatch(i + idx, b)));
  }

  const examples: Array<{ id: string; summary: string; description: string }> = [];
  for (const entry of resultMap.values()) {
    if (examples.length < 2) {
      examples.push({ id: entry.id, summary: entry.summary, description: entry.description });
    }
  }

  const finalEntries = entries.map((e) => resultMap.get(e.id)!);
  writeEnrichmentRejections(options.checkpointPath, rejections);
  return {
    entries: finalEntries,
    rejections,
    stats: {
      total: entries.length,
      passedFirstTry,
      neededRetry,
      fellBack,
      wallClockMs: Date.now() - startTime,
      exampleDescriptions: examples,
    },
  };
}
