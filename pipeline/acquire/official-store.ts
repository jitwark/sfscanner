import { createReadStream } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The official templates' workflow bodies, one JSON object per line.
 *
 * They are deliberately NOT written into `official-entries.json`: that file is
 * rewritten whole after every page, so putting ~350 MB of bodies in it would
 * cost more in write amplification than the download itself. Appending is O(1)
 * per record and survives a kill mid-run.
 *
 * These bodies are retained for *analysis* — dedup fingerprints, the security
 * scan, readiness, and hostnames. Rights stay `link_only` and none of this is
 * ever published. See `phase-7-official-json.md`.
 */
export type StoredWorkflow = {
  templateId: number;
  workflow: Record<string, unknown> | null;
  /** Present only for a targeted run. The crawl stores bodies alone. */
  provenance?: StoredProvenance;
};

/**
 * What a targeted run saw when it asked for one id. `reason` is the acquirer's
 * own verdict — `gone` is an upstream 404/400, not a failure of ours — and the
 * status is recorded beside it so the receipt can carry the code it saw.
 */
export type StoredProvenance = {
  url: string;
  fetchedAt: string;
  httpStatus: number;
  reason: 'ok' | 'gone' | 'failed';
};

export function workflowStorePath(workDir: string): string {
  return join(workDir, 'official-workflows.jsonl');
}

/** Write-then-rename, so a kill mid-write cannot truncate a checkpoint. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

export async function appendWorkflows(path: string, records: StoredWorkflow[]): Promise<void> {
  if (records.length === 0) return;
  const payload = records
    .map((r) => JSON.stringify({
      templateId: r.templateId,
      workflow: r.workflow,
      ...(r.provenance ? { provenance: r.provenance } : {}),
    }))
    .join('\n');
  await appendFile(path, payload + '\n', 'utf8');
}

function readProvenance(value: unknown): StoredProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.url !== 'string' || typeof rec.fetchedAt !== 'string') return undefined;
  if (typeof rec.httpStatus !== 'number') return undefined;
  if (rec.reason !== 'ok' && rec.reason !== 'gone' && rec.reason !== 'failed') return undefined;
  return { url: rec.url, fetchedAt: rec.fetchedAt, httpStatus: rec.httpStatus, reason: rec.reason };
}

async function eachRecord(
  path: string,
  onRecord: (record: StoredWorkflow) => void,
): Promise<void> {
  let stream;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      stream!.once('open', () => resolve());
      stream!.once('error', reject);
    });
  } catch {
    return; // No store yet: an empty result, not a failure.
  }

  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only ever the final line, torn by a kill mid-append. Everything before
      // it parsed, and discarding those to punish one partial record is worse.
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.templateId !== 'number' || !('workflow' in rec)) continue;
    const workflow = rec.workflow;
    // `null` is a record too: a targeted run stores the ids it asked for and
    // could not retain, so the receipt can account for every one of them.
    if (workflow !== null && (typeof workflow !== 'object' || Array.isArray(workflow))) continue;
    const record: StoredWorkflow = {
      templateId: rec.templateId,
      workflow: workflow as Record<string, unknown> | null,
    };
    const provenance = readProvenance(rec.provenance);
    if (provenance) record.provenance = provenance;
    onRecord(record);
  }
}

/** Later records win, so re-fetching a torn page repairs it. */
export async function readWorkflowMap(path: string): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  await eachRecord(path, (r) => {
    if (r.workflow) map.set(r.templateId, r.workflow);
  });
  return map;
}

/**
 * Every record as stored, provenance included — what the body-file emitter
 * needs. Records kept in file order; the caller decides what "later wins" means.
 */
export async function readWorkflowRecords(path: string): Promise<StoredWorkflow[]> {
  const records: StoredWorkflow[] = [];
  await eachRecord(path, (record) => {
    records.push(record);
  });
  return records;
}

export async function loadWorkflowIds(path: string): Promise<Set<number>> {
  const ids = new Set<number>();
  await eachRecord(path, (r) => {
    ids.add(r.templateId);
  });
  return ids;
}
