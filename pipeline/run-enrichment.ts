/**
 * Phase 3 production runner: describe the canonical corpus, then package it.
 *
 * `build-corpus.ts` produces acquisition output with deterministic facts and a
 * fallback summary. This script adds the written description that a reader
 * actually gets, then derives charts, tags, the search index, facets, and the
 * deployable artifacts under `data/`.
 *
 * Entries are described in quality order, best first, so an interrupted run
 * still leaves the most useful pages complete. Descriptions are checkpointed by
 * entry id, so re-running resumes rather than re-spending tokens.
 *
 *   npx tsx pipeline/run-enrichment.ts --run prod-gh3 --generated-at 2026-08-28T00:00:00.000Z [--limit 500]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIndexable, type Entry, type WorkflowChart } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import {
  assertAcquisitionComplete,
  readAcquisitionManifest,
  writeAcquisitionManifest,
  type AcquisitionManifest,
} from './acquire/acquisition-manifest.js';
import { DEFAULT_PROMPT_VERSION } from './enrich/describe.js';
import { resolveEnrichmentModel } from './enrich/antigravity-proxy.js';
import { buildEnrichmentIdentity, isCheckpointCompatible } from './enrich/enrichment-identity.js';
import { runDescriptionBatch } from './enrich/describe-batch-cli.js';
import { isCompleteGeneratedCheckpoint } from './enrich/checkpoint-validity.js';
import { runEnrichCorpus } from './enrich-corpus.js';
import { sanitizeWorkflow } from './sanitize/redact.js';
import { getScannerVersion, scanCandidate } from './scan/scan-entry.js';
import { scanWorkflowWithCore } from './scan/scanner-core-adapter.js';
import { entryId } from './acquire/entry-id.js';
import { parseSourcesJson } from './sources.schema.js';
import { parseArgs, type EnrichmentArgs } from './enrich/enrichment-args.js';

export { parseArgs, type EnrichmentArgs };
type DescriptionCheckpoint = Record<
  string,
  {
    summary: string;
    description: string;
    descriptionSource: Entry['descriptionSource'];
    descriptionProvenance?: Entry['descriptionProvenance'];
    descriptionContent?: Entry['descriptionContent'];
    identity?: import('./enrich/enrichment-identity').EnrichmentIdentity;
  }
>;

export function selectDescriptionTargets(
  entries: Entry[],
  checkpoint: DescriptionCheckpoint,
  limit: number,
  retryFallbacks: boolean,
  checkpointCompatible?: (entry: Entry, checkpoint: DescriptionCheckpoint[string]) => boolean,
): Entry[] {
  return entries
    .filter((entry) => {
      const prior = checkpoint[entry.id];
      if (!prior) return true;
      if (retryFallbacks && prior.descriptionSource === 'fallback') return true;
      return checkpointCompatible ? !checkpointCompatible(entry, prior) : false;
    })
    .slice(0, limit);
}

/**
 * A paginated upstream catalogue can repeat one official template at a page
 * boundary. Keep one record for packaging, but fail closed if duplicates carry
 * different non-volatile metadata instead of silently choosing one.
 */
export function uniqueCanonicalEntries(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  const signatures = new Map<string, string>();
  for (const entry of entries) {
    const source = { ...entry.source } as Record<string, unknown>;
    delete source.fetchedAt;
    const signature = JSON.stringify({ ...entry, source });
    const prior = byId.get(entry.id);
    if (!prior) {
      byId.set(entry.id, entry);
      signatures.set(entry.id, signature);
      continue;
    }
    if (signatures.get(entry.id) !== signature) {
      throw new Error(`Duplicate canonical entry ID has conflicting records: ${entry.id}`);
    }
  }
  return [...byId.values()];
}

export async function enforceAcquisitionGate(
  workDir: string,
  acceptPartial: boolean,
): Promise<AcquisitionManifest> {
  const acquisitionPath = path.join(workDir, 'acquisition-manifest.json');
  const sourcesPath = path.join(process.cwd(), 'pipeline', 'sources.json');
  const activeSourceKeys = parseSourcesJson(fs.readFileSync(sourcesPath, 'utf8'))
    .filter((source) => source.status === 'active')
    .map((source) => source.key);
  const manifest = await readAcquisitionManifest(acquisitionPath, activeSourceKeys);
  assertAcquisitionComplete(manifest, acceptPartial);
  if (acceptPartial && !manifest.acceptPartial) {
    const accepted = { ...manifest, acceptPartial: true };
    await writeAcquisitionManifest(workDir, accepted);
    return accepted;
  }
  return manifest;
}

/**
 * Rank for description spend: a workflow that is larger, connects more services,
 * and carries a real upstream title is worth describing before a two-node stub.
 */
function qualityRank(entry: Entry): number {
  const structure = entry.structure;
  const nodes = Math.min(structure?.nodeCount ?? 0, 60);
  const integrations = Math.min((structure?.integrations ?? []).length, 8) * 6;
  const titled = (entry.title ?? '').trim().length > 24 ? 12 : 0;
  const described = entry.descriptionSource === 'upstream' ? 20 : 0;
  return nodes + integrations + titled + described;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.generatedAt && !args.preflightOnly && !args.verifyOnly) {
    throw new Error('Description/package generation requires --generated-at <ISO timestamp> or SOURCE_DATE_EPOCH; release clocks are never read from the wall clock.');
  }
  if (!args.preflightOnly && !args.verifyOnly && !args.skipDescribe && !args.allowLiveGemini) {
    throw new Error('Live Gemini enrichment is disabled by default; pass --allow-live-gemini explicitly.');
  }
  if (!args.preflightOnly && !args.verifyOnly && !args.skipDescribe && !args.requireGemini) {
    throw new Error('Production enrichment is fail-closed: pass --require-gemini so fallback prose cannot be published.');
  }
  if (!args.preflightOnly && !args.verifyOnly && !args.skipDescribe && !args.describeOnly && !args.stagingDir) {
    throw new Error('Live enrichment must write to a staging directory; pass --staging-dir <path>.');
  }
  const workDir = path.join(process.cwd(), 'pipeline', '.work', args.runId);
  await enforceAcquisitionGate(workDir, args.acceptPartial);
  const entriesPath = path.join(workDir, 'entries.json');

  const raw = JSON.parse(fs.readFileSync(entriesPath, 'utf8')) as Array<
    { entry?: Entry; chart?: unknown } | Entry
  >;
  const all = raw.map((record) =>
    'entry' in record && record.entry ? record.entry : (record as Entry),
  );
  const chartsById = new Map<string, WorkflowChart>();
  for (const record of raw) {
    if ('entry' in record && record.entry && record.chart) {
      chartsById.set(record.entry.id, record.chart as WorkflowChart);
    }
  }
  const canonical = uniqueCanonicalEntries(all.filter((entry) => entry.dedup?.canonical === true));
  canonical.sort((a, b) => qualityRank(b) - qualityRank(a) || compareCanonicalStrings(a.id, b.id));

  const selected = args.limit ? canonical.slice(0, args.limit) : canonical;
  process.stdout.write(
    `run ${args.runId}: ${all.length} records, ${canonical.length} canonical, ${selected.length} selected\n`,
  );

  // `--skip-describe` means "spend no tokens", not "throw away finished work":
  // descriptions already written to the checkpoint are applied either way.
  const checkpointPath = args.checkpointPath
    ? path.resolve(process.cwd(), args.checkpointPath)
    : path.join(workDir, 'describe-checkpoint.json');
  const checkpoint: DescriptionCheckpoint = fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
    : {};
  let described = selected;
  let applied = 0;
  described = selected.map((entry) => {
    const hit = checkpoint[entry.id];
    if (!hit) return entry;
    applied++;
    return {
      ...entry,
      summary: hit.summary,
      description: hit.description,
      descriptionSource: hit.descriptionSource,
      ...(hit.descriptionProvenance ? { descriptionProvenance: hit.descriptionProvenance } : {}),
      ...(hit.descriptionContent ? { descriptionContent: hit.descriptionContent } : {}),
    };
  });
  if (applied > 0) {
    process.stdout.write(`applied ${applied} checkpointed descriptions\n`);
  }

  // Build from finished entries only. Used for a preview while enrichment is
  // still running: the site then reflects real pages rather than a corpus that
  // is mostly waiting for prose.
  if (args.onlyDescribed) {
    const before = described.length;
    described = described.filter((entry) => args.requireGemini
      ? entry.descriptionSource === 'generated' && Boolean(entry.descriptionContent)
      : entry.descriptionSource !== 'fallback');
    process.stdout.write(`only-described: ${described.length} of ${before} entries\n`);
  }

  // Sanitized workflow bodies for the download packs, written alongside
  // entries.json by acquisition. Absent for corpora built before that existed.
  // Bodies are re-sanitized here rather than trusted from disk: runs recorded
  // before sanitizer v2 kept root residue fields (meta, pinData, instanceId…),
  // and the privacy audit correctly rejects any pack line carrying them. The
  // model-side map deliberately keeps the stored bytes — enrichment checkpoint
  // identities hash exactly those, and changing them would invalidate every
  // checkpointed description.
  const workflowsById = new Map<string, unknown>();
  const modelWorkflowsById = new Map<string, unknown>();
  const workflowsPath = path.join(workDir, 'workflows.jsonl');
  if (fs.existsSync(workflowsPath)) {
    let resanitized = 0;
    for (const line of fs.readFileSync(workflowsPath, 'utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line) as { id: string; workflow: unknown };
      const result = sanitizeWorkflow(record.workflow);
      if (result.ok && result.manifest.length > 0) resanitized += 1;
      workflowsById.set(record.id, result.ok ? result.workflow : record.workflow);
      modelWorkflowsById.set(record.id, record.workflow);
    }
    process.stdout.write(`loaded ${workflowsById.size} sanitized workflows for packs (${resanitized} re-sanitized on load)\n`);
  } else {
    process.stdout.write('no workflows.jsonl in this run: download packs will be empty\n');
  }
  const modelWorkflowsPath = path.join(workDir, 'model-workflows.jsonl');
  if (fs.existsSync(modelWorkflowsPath)) {
    for (const line of fs.readFileSync(modelWorkflowsPath, 'utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line) as { id: string; workflow: unknown };
      modelWorkflowsById.set(record.id, record.workflow);
    }
  } else {
    // Backward-compatible recovery for runs created before model-workflows.jsonl.
    const officialPath = path.join(workDir, 'official-workflows.jsonl');
    if (fs.existsSync(officialPath)) {
      for (const line of fs.readFileSync(officialPath, 'utf8').split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as { templateId: number; workflow: unknown };
        modelWorkflowsById.set(entryId('n8n_official', 'n8n.io', String(record.templateId)), record.workflow);
      }
    }
  }
  process.stdout.write(`loaded ${modelWorkflowsById.size} local workflow bodies for model-safe enrichment\n`);

  // Re-scan security with the current scanner wherever the recorded version is
  // unknown or stale. The corpus predates scanner-version stamping, so every
  // entry would otherwise fail release metadata's known-scannerVersion rule.
  // Scanning reads only the sanitized body and the deterministic engine; the
  // description checkpoint identity hashes a separate model-safe projection,
  // so re-stamping security cannot invalidate any checkpointed prose.
  {
    const scannerVer = getScannerVersion();
    const needsRescan = described.filter((entry) =>
      !entry.security?.scannerVersion || entry.security.scannerVersion !== scannerVer);
    let rescanned = 0;
    let noBody = 0;
    // In-process scan function: the worker path cannot load .ts under tsx.
    const inProcessScan = (workflow: unknown, scanOptions?: { policyProfile?: 'beta-default' | 'beta-hardened' }) => {
      return scanWorkflowWithCore(
        workflow as Parameters<typeof scanWorkflowWithCore>[0],
        { policyProfile: scanOptions?.policyProfile ?? 'beta-default' },
      );
    };
    for (const entry of needsRescan) {
      // Prefer the pack body; fall back to the model-safe store, which also
      // holds every official-template body we retained at acquisition.
      const workflow = workflowsById.get(entry.id) ?? modelWorkflowsById.get(entry.id);
      if (workflow === undefined) { noBody += 1; continue; }
      const security = await scanCandidate(
        { id: entry.id, json: workflow } as Parameters<typeof scanCandidate>[0],
        { scannerVersion: scannerVer, scan: inProcessScan },
      );
      entry.security = security;
      rescanned += 1;
    }
    if (noBody > 0) {
      // Genuinely body-less link-only entries get an explicit marker rather
      // than the ambiguous 'unknown'.
      for (const entry of needsRescan) {
        if (!entry.security || entry.security.scannerVersion === 'unknown') {
          entry.security = {
            grade: 'UNKNOWN',
            score: 0,
            counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            findings: [],
            hardenedExtra: 0,
            scannerVersion: 'not-scanned',
            profile: 'beta-default',
          };
        }
      }
      process.stdout.write(`${noBody} entries have no retained body; stamped as not-scanned\n`);
    }
    if (rescanned > 0) {
      process.stdout.write(`re-scanned ${rescanned} entries with scanner ${scannerVer}\n`);
    }
    // Link-only catalogue references with no retained body cannot be scanned.
    // Stamp that fact explicitly rather than leaving the ambiguous 'unknown':
    // release metadata rejects unknown versions but accepts an explicit
    // not-scanned marker on entries that were never scannable.
    let stampedNotScanned = 0;
    for (const entry of described) {
      if (!entry.security || entry.security.scannerVersion === 'unknown') {
        entry.security = {
          grade: 'UNKNOWN',
          score: 0,
          counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          findings: [],
          hardenedExtra: 0,
          scannerVersion: 'not-scanned',
          profile: 'beta-default',
        };
        stampedNotScanned += 1;
      }
    }
    if (stampedNotScanned > 0) {
      process.stdout.write(`stamped ${stampedNotScanned} body-less entries as not-scanned\n`);
    }
  }

  if (!args.skipDescribe) {
    const describeCount = Math.min(args.describeLimit ?? selected.length, selected.length);
    const promptPath = path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt');
    const promptText = fs.readFileSync(promptPath, 'utf8');
    const targets = selectDescriptionTargets(
      described,
      checkpoint,
      describeCount,
      args.retryFallbacks,
      (entry, prior) => {
        const workflow = modelWorkflowsById.get(entry.id);
        if (workflow === undefined || !prior.identity) return false;
        const identity = buildEnrichmentIdentity(workflow, {
          promptText,
          promptVersion: DEFAULT_PROMPT_VERSION,
          model: resolveEnrichmentModel(),
        });
        return isCheckpointCompatible(prior, identity) && isCompleteGeneratedCheckpoint(entry, prior, workflow);
      },
    );

    described = await runDescriptionBatch({
      runId: args.runId, targets, described, workflowsById: modelWorkflowsById,
      checkpointPath, workDir, batchLedgerPath: args.batchLedgerPath, batchManifestPath: args.batchManifestPath,
      enrichmentBatchSize: args.enrichmentBatchSize, verifyOnly: args.verifyOnly,
      preflightOnly: args.preflightOnly,
      batchSize: args.batchSize, concurrency: args.concurrency, timeoutMs: args.timeoutMs,
      retryFallbacks: args.retryFallbacks, regenerateDescriptions: args.regenerateDescriptions,
      generatedAt: args.generatedAt,
      failOnRejection: !args.describeOnly,
    });
  }

  if (args.describeOnly || args.verifyOnly || args.preflightOnly) {
    process.stdout.write('description checkpoint updated; packaging skipped\n');
    return;
  }

  const outputDir = args.stagingDir
    ? path.resolve(process.cwd(), args.stagingDir)
    : path.join(process.cwd(), 'data');
  const packaged = runEnrichCorpus({
    entries: described,
    chartsById,
    workflowsById,
    compatibilityWorkflowsById: modelWorkflowsById,
    outputDir,
    checkpointPath: path.join(workDir, 'package-checkpoint.json'),
    requireGemini: args.requireGemini,
    generatedAt: args.generatedAt!,
  });

  const indexable = packaged.entries.filter(isIndexable).length;
  process.stdout.write(
    `packaged ${packaged.totalEntries} entries into ${outputDir}; ${indexable} are indexable\n`,
  );
  for (const item of packaged.sizeTable.slice(0, 8)) {
    process.stdout.write(
      `  ${item.path.padEnd(24)} ${(item.compressedBytes / 1024).toFixed(0).padStart(7)} KB gzip\n`,
    );
  }
  process.stdout.write(
    `budgets: search index under 8 MB ${packaged.budgetsMet.searchIndexUnder8MB}, homepage under 200 KB ${packaged.budgetsMet.homepageUnder200KB}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
