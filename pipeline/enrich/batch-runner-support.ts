import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { DEFAULT_PROMPT_VERSION, type DescribeOptions } from './describe.js';
import { buildEnrichmentIdentity, DESCRIPTION_SCHEMA_VERSION, MODEL_INPUT_SANITIZER_VERSION, type EnrichmentIdentity } from './enrichment-identity.js';
import { resolveEnrichmentModel } from './antigravity-proxy.js';

export type CheckpointItem = {
  summary: string;
  description: string;
  descriptionSource: Entry['descriptionSource'];
  descriptionProvenance?: Entry['descriptionProvenance'];
  descriptionContent?: Entry['descriptionContent'];
  identity?: EnrichmentIdentity;
};

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function checkpointHash(filePath: string, ids?: readonly string[]): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!ids) return sha256(raw);
    const checkpoint = JSON.parse(raw) as Record<string, CheckpointItem>;
    const selected = ids.map((id) => [id, checkpoint[id]] as const);
    if (selected.some(([, item]) => !item)) return '';
    return sha256(JSON.stringify(selected));
  } catch {
    return '';
  }
}

export function readPrompt(options: DescribeOptions): string {
  const filePath = options.systemPromptPath ?? path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt');
  return fs.readFileSync(filePath, 'utf8');
}

export function identitiesFor(input: {
  entries: Entry[];
  workflowsById: ReadonlyMap<string, unknown>;
  describeOptions: DescribeOptions;
}): Map<string, EnrichmentIdentity> {
  const promptText = readPrompt(input.describeOptions);
  const promptVersion = input.describeOptions.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const model = input.describeOptions.model ?? resolveEnrichmentModel();
  const identities = new Map<string, EnrichmentIdentity>();
  for (const entry of input.entries) {
    const workflow = input.workflowsById.get(entry.id);
    if (workflow === undefined) throw new Error(`workflow JSON is missing for ${entry.id}`);
    identities.set(entry.id, buildEnrichmentIdentity(workflow, {
      promptText,
      promptVersion,
      model,
      sanitizerVersion: input.describeOptions.sanitizerVersion ?? MODEL_INPUT_SANITIZER_VERSION,
      schemaVersion: input.describeOptions.schemaVersion ?? DESCRIPTION_SCHEMA_VERSION,
    }));
  }
  return identities;
}

export function batchIdentity(runId: string, entries: Entry[], identities: ReadonlyMap<string, EnrichmentIdentity>): string {
  return sha256(JSON.stringify({ runId, ids: entries.map((entry) => entry.id), identities: entries.map((entry) => identities.get(entry.id)) }));
}

export function readCheckpoint(filePath: string): Record<string, CheckpointItem> {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, CheckpointItem>; } catch { return {}; }
}

export function fromCheckpoint(entry: Entry, checkpoint: CheckpointItem, identity: EnrichmentIdentity): Entry {
  const provenance = checkpoint.descriptionProvenance;
  const generatedAt = provenance?.generatedAt;
  if (checkpoint.descriptionSource === 'generated' && !generatedAt) throw new Error('Generated checkpoint is missing its release timestamp');
  return {
    ...entry,
    summary: checkpoint.summary,
    description: checkpoint.description,
    descriptionSource: checkpoint.descriptionSource,
    ...(checkpoint.descriptionContent ? { descriptionContent: checkpoint.descriptionContent } : {}),
    ...(checkpoint.descriptionSource === 'generated' ? {
      descriptionProvenance: {
        source: 'gemini', model: identity.model, promptVersion: identity.promptVersion,
        promptHash: identity.promptHash, schemaVersion: identity.schemaVersion,
        workflowHash: identity.workflowHash, generatedAt: generatedAt!,
      },
    } : provenance ? { descriptionProvenance: provenance } : {}),
  };
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;.]+/gi, '$1: [redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .replace(/[\r\n].*$/u, '')
    .slice(0, 240);
}

export async function wait(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

export function writeInputManifest(filePath: string, input: {
  runId: string;
  entries: Entry[];
  identities: ReadonlyMap<string, EnrichmentIdentity>;
  batchSize: number;
}): string {
  const batches: Array<{ batchIndex: number; ids: string[]; identityHash: string }> = [];
  for (let index = 0; index < input.entries.length; index += input.batchSize) {
    const batch = input.entries.slice(index, index + input.batchSize);
    batches.push({
      batchIndex: batches.length,
      ids: batch.map((entry) => entry.id),
      identityHash: batchIdentity(input.runId, batch, input.identities),
    });
  }
  const core = {
    manifestVersion: 1,
    runId: input.runId,
    count: input.entries.length,
    entries: input.entries.map((entry) => ({ id: entry.id, identity: input.identities.get(entry.id) })),
    batches,
  };
  const manifest = { ...core, createdAt: new Date().toISOString(), manifestHash: sha256(JSON.stringify(core)) };
  let destination = filePath;
  try {
    const prior = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { manifestHash?: string };
    if (prior.manifestHash !== manifest.manifestHash) destination = `${filePath}.${manifest.manifestHash.slice(0, 12)}.json`;
  } catch { /* first write */ }
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, destination);
  }
  return destination;
}
