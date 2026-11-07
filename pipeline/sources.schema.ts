import type { SourceDef } from '@hub/contracts';

const FIELDS = new Set(['key', 'kind', 'repo', 'branch', 'include', 'exclude', 'expectedLicence', 'status', 'note', 'redistribute', 'reviewedAt']);
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(index: number, message: string): never {
  throw new Error(`sources[${index}]: ${message}`);
}

export function validateSources(value: unknown): SourceDef[] {
  if (!Array.isArray(value)) throw new Error('sources must be an array');
  const keys = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(index, 'must be an object');
    const source = raw as Record<string, unknown>;
    for (const field of Object.keys(source)) if (!FIELDS.has(field)) fail(index, `unknown field ${field}`);
    for (const field of ['key', 'kind', 'include', 'exclude', 'status', 'note', 'reviewedAt']) {
      if (!(field in source)) fail(index, `missing ${field}`);
    }
    if (typeof source.key !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(source.key)) fail(index, 'key is malformed');
    if (keys.has(source.key)) fail(index, `duplicate key ${source.key}`);
    keys.add(source.key);
    if (source.kind !== 'github' && source.kind !== 'n8n_official') fail(index, 'kind is invalid');
    if (!Array.isArray(source.include) || source.include.some((x) => typeof x !== 'string')) fail(index, 'include must be string[]');
    if (!Array.isArray(source.exclude) || source.exclude.some((x) => typeof x !== 'string')) fail(index, 'exclude must be string[]');
    if (source.kind === 'github') {
      if (typeof source.repo !== 'string' || !REPO.test(source.repo)) fail(index, 'repo is malformed');
      if (typeof source.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(source.branch)) fail(index, 'branch is malformed');
    } else if ('repo' in source || 'branch' in source) {
      fail(index, 'official sources cannot define repo or branch');
    }
    if (!(source.expectedLicence === null || typeof source.expectedLicence === 'string')) fail(index, 'expectedLicence must be string|null');
    if (source.status !== 'active' && source.status !== 'excluded') fail(index, 'status is invalid');
    if (typeof source.note !== 'string' || source.note.trim().length === 0) fail(index, 'note is required');
    // Only `false` is meaningful: redistribution is granted by evidence, not by
    // a flag, so there is nothing for `true` to mean here.
    if ('redistribute' in source && source.redistribute !== false) fail(index, 'redistribute may only be false');
    if (typeof source.reviewedAt !== 'string' || !DATE.test(source.reviewedAt)) fail(index, 'reviewedAt is invalid');
    return source as SourceDef;
  });
}

export function parseSourcesJson(text: string): SourceDef[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`invalid sources JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return validateSources(value);
}
