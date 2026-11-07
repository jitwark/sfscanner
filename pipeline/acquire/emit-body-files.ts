import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOfficialBodyFileName } from '../official-map/body-map.js';
import { readWorkflowRecords, type StoredWorkflow } from './official-store.js';

/**
 * Turn a targeted run's workflow store into `official__<id>_<slug>.json` body
 * files, plus one provenance receipt per fetched id.
 *
 *   npx tsx pipeline/acquire/emit-body-files.ts --jsonl <store> --out <dir>
 *
 * `--out` is required and never defaulted: these bodies live outside the
 * repository (they are not redistributable) and a wrong folder is a wrong
 * corpus. The folder is created here, when the emitter runs.
 */
export const RECEIPT_FILE = 'official-body-provenance.jsonl';

/**
 * The curated folder is the reference for this convention: its longest slug is
 * exactly 80 characters, with 1,110 files sitting at that ceiling.
 */
const MAX_SLUG = 80;
const FALLBACK_SLUG = 'workflow';

export type EmitOptions = { jsonl: string; out: string };

export type EmitSummary = {
  bodies: number;
  gone: number;
  failed: number;
  receipts: string;
  out: string;
};

type Receipt = {
  templateId: number;
  url: string;
  fetchedAt: string;
  httpStatus: number;
  sha256: string | null;
  bytes: number | null;
  state: 'fetched' | 'gone' | 'failed';
  file?: string;
};

/**
 * Everything outside `[a-z0-9]` collapses to `-`, so no emitted name can carry
 * a character a filesystem refuses (`\ / : * ? " < > |`, control characters) or
 * a trailing dot/space that Windows silently strips. It also means the slug can
 * never contain `.`, so the `.json` the join rule anchors on is unambiguous —
 * unlike the curated folder, which kept `.` inside slugs such as `VEED.io`.
 */
function bodySlug(name: unknown): string {
  const title = typeof name === 'string' ? name : '';
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || FALLBACK_SLUG;
}

/**
 * Build the one filename grammar the body map joins on. The result is parsed
 * back through the same reader the join uses, so a change to that grammar
 * anywhere fails here loudly instead of quietly orphaning the body.
 */
export function bodyFileName(templateId: number, workflow: Record<string, unknown>): string {
  if (!Number.isSafeInteger(templateId) || templateId <= 0) {
    throw new Error(`not a template id: ${JSON.stringify(templateId)}`);
  }
  const slug = bodySlug(workflow.name);
  const name = `official__${templateId}_${slug}.json`;
  const parsed = parseOfficialBodyFileName(name);
  if (!parsed || parsed.templateId !== templateId || parsed.slug !== slug) {
    throw new Error(`${name} does not satisfy the official body join rule`);
  }
  return name;
}

/** Later records win, so finishing an interrupted targeted run cannot double-emit. */
function latestById(records: readonly StoredWorkflow[]): StoredWorkflow[] {
  const byId = new Map<number, StoredWorkflow>();
  for (const record of records) byId.set(record.templateId, record);
  return [...byId.values()].sort((a, b) => a.templateId - b.templateId);
}

/** Write-then-rename, so a kill mid-write cannot leave a half-written receipt. */
async function atomicJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  const temporary = `${path}.tmp`;
  const lines = rows.map((row) => JSON.stringify(row));
  await writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  await rename(temporary, path);
}

export async function emitBodyFiles(options: EmitOptions): Promise<EmitSummary> {
  const records = latestById(await readWorkflowRecords(options.jsonl));
  await mkdir(options.out, { recursive: true });

  const rows: Receipt[] = [];
  let bodies = 0;
  let gone = 0;
  let failed = 0;

  for (const record of records) {
    const provenance = record.provenance;
    // Provenance is acquired, never inferred: a body we cannot describe is a
    // body nobody can admit later, and guessing at it is how the master folder
    // ended up carrying verdicts nothing can vouch for.
    if (!provenance) throw new Error(`record ${record.templateId} has no provenance`);
    const base = {
      templateId: record.templateId,
      url: provenance.url,
      fetchedAt: provenance.fetchedAt,
      httpStatus: provenance.httpStatus,
    };

    if (provenance.reason === 'gone') {
      rows.push({ ...base, sha256: null, bytes: null, state: 'gone' });
      gone += 1;
      continue;
    }
    if (provenance.reason === 'failed' || !record.workflow) {
      rows.push({ ...base, sha256: null, bytes: null, state: 'failed' });
      failed += 1;
      continue;
    }

    const name = bodyFileName(record.templateId, record.workflow);
    const bytes = Buffer.from(`${JSON.stringify(record.workflow, null, 2)}\n`, 'utf8');
    await writeFile(join(options.out, name), bytes);
    rows.push({
      ...base,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      state: 'fetched',
      file: name,
    });
    bodies += 1;
  }

  const receipts = join(options.out, RECEIPT_FILE);
  await atomicJsonl(receipts, rows);
  return { bodies, gone, failed, receipts, out: options.out };
}

export function parseArgs(argv: readonly string[]): EmitOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const jsonl = values.get('jsonl');
  if (!jsonl) throw new Error('--jsonl <file> is required: the emitter reads the store a targeted run wrote');
  const out = values.get('out');
  if (!out) throw new Error('--out <dir> is required: the emitter never guesses where bodies belong');
  return { jsonl, out };
}

if (process.argv[1]?.endsWith('emit-body-files.ts') || process.argv[1]?.endsWith('emit-body-files.js')) {
  emitBodyFiles(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify(summary));
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : 'body emission failed');
      process.exitCode = 1;
    });
}
