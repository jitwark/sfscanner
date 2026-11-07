import { createHash } from 'node:crypto';

/** Build-time admission manifest: compile records, then admit only with an APPROVED detached receipt. */
export type Digest = string;
export type ManifestRecord = Readonly<{ key: string; recordDigest: Digest; evidenceDigest: Digest; fixtureDigest: Digest; resource: string | null }>;
export type AdmissionManifest = Readonly<{
  schemaVersion: '1'; candidateSetDigest: Digest; templateDigest: Digest;
  sourceReceiptDigests: readonly Digest[]; records: readonly ManifestRecord[];
}>;
export type BatchReviewReceipt = Readonly<{
  schemaVersion: '1'; manifestDigest: Digest; reviewer: string; reviewedAt: string;
  decision: 'APPROVED' | 'REJECTED'; evidenceArtifactDigest: Digest;
}>;
export type ModelAdmissionReceipt = Readonly<{ key: string; recordDigest: Digest; manifestDigest: Digest; reviewReceiptDigest: Digest }>;
export type BatchCandidate = Readonly<{
  key: string; record: unknown; evidenceDigest: Digest; fixtureDigest: Digest; resource?: string | null;
}>;
export type AdmissionFailure = Readonly<{ ok: false; reason: string; label: string }>;
export type AdmissionSuccess = Readonly<{ ok: true; receipts: readonly ModelAdmissionReceipt[] }>;

const HEX = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ENTRY = ['EQ', 'GTE', 'GT', 'LTE', 'LT'] as const;
type Op = (typeof ENTRY)[number];
type Bound = Readonly<{ version: string; inclusive: boolean }>;
type Interval = Readonly<{ lower: Bound | null; upper: Bound | null }>;

const fail = (reason: string, label: string): AdmissionFailure => Object.freeze({ ok: false, reason, label });
const sha256 = (value: unknown): Digest => createHash('sha256').update(canonical(value)).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('Manifest values must be closed JSON data.');
}

function compareVersion(left: string, right: string): number {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

function intervalsOf(range: unknown, label: string): readonly Interval[] {
  if (!isRecord(range) || !Array.isArray(range.clauses)) throw new TypeError(`${label}.versionRange`);
  return (range.clauses as unknown[]).map((clause) => {
  if (!Array.isArray(clause) || clause.length === 0) throw new TypeError(`${label}.versionRange`);
  let lower: Bound | null = null; let upper: Bound | null = null;
  for (const item of clause) {
    if (!isRecord(item) || !ENTRY.includes(item.op as Op) || typeof item.version !== 'string' || !VERSION.test(item.version)) throw new TypeError(`${label}.versionRange`);
    const op = item.op as Op; const version = item.version;
    if (op === 'EQ') { lower = { version, inclusive: true }; upper = { version, inclusive: true }; }
    if (op === 'GTE' || op === 'GT') {
      if (lower === null || compareVersion(version, lower.version) > 0) lower = { version, inclusive: op === 'GTE' };
    }
    if (op === 'LTE' || op === 'LT') {
      if (upper === null || compareVersion(version, upper.version) < 0) upper = { version, inclusive: op === 'LTE' };
    }
  }
  return { lower, upper };
  });
}

function overlaps(left: Interval, right: Interval): boolean {
  const low = left.lower === null ? right.lower : right.lower === null ? left.lower
    : compareVersion(left.lower.version, right.lower.version) >= 0 ? left.lower : right.lower;
  const high = left.upper === null ? right.upper : right.upper === null ? left.upper
    : compareVersion(left.upper.version, right.upper.version) <= 0 ? left.upper : right.upper;
  if (low === null || high === null) return true;
  const cmp = compareVersion(low.version, high.version);
  return cmp < 0 || (cmp === 0 && low.inclusive && high.inclusive);
}

function digestField(value: unknown, label: string): Digest {
  if (typeof value !== 'string' || !HEX.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function scope(candidate: BatchCandidate): { nodeType: string; operation: string | null; resource: string | null; intervals: readonly Interval[] } {
  const record = candidate.record;
  if (!isRecord(record) || typeof record.nodeType !== 'string' || record.nodeType.length === 0) throw new TypeError(`${candidate.key}.record.nodeType`);
  const operation = record.operation === null ? null : record.operation;
  if (operation !== null && (typeof operation !== 'string' || operation.length === 0)) throw new TypeError(`${candidate.key}.record.operation`);
  if (operation === '*') throw new TypeError(`${candidate.key}: wildcard operation claims are not admissible.`);
  if (operation !== null && operation.includes('{{')) throw new TypeError(`${candidate.key}: dynamic operation claims are not admissible.`);
  const resource = candidate.resource ?? null;
  if (resource !== null && (typeof resource !== 'string' || resource.length === 0 || resource.includes('{{'))) throw new TypeError(`${candidate.key}.resource`);
  return { nodeType: record.nodeType, operation, resource, intervals: intervalsOf(record.versionRange, candidate.key) };
}

export function compileManifest(input: Readonly<{
  templateDigest: Digest; sourceReceiptDigests: readonly Digest[]; candidates: readonly BatchCandidate[];
}>): Readonly<{ candidates: readonly BatchCandidate[]; manifest: AdmissionManifest }> {
  const templateDigest = digestField(input.templateDigest, 'templateDigest');
  const sourceReceiptDigests = Object.freeze([...new Set(input.sourceReceiptDigests.map((value, index) => digestField(value, `sourceReceiptDigests[${index}]`)))].sort());
  const keys = new Set<string>(); const scoped: { key: string; scope: ReturnType<typeof scope> }[] = [];
  const records = input.candidates.map((candidate) => {
    if (typeof candidate.key !== 'string' || candidate.key.length === 0) throw new TypeError('candidate.key');
    if (keys.has(candidate.key)) throw new TypeError(`Duplicate candidate key: ${candidate.key}`);
    keys.add(candidate.key);
    const current = scope(candidate);
    for (const prior of scoped) {
      if (prior.scope.nodeType === current.nodeType && prior.scope.operation === current.operation
        && prior.scope.resource === current.resource
        && prior.scope.intervals.some((left) => current.intervals.some((right) => overlaps(left, right)))) {
        throw new TypeError(`Overlapping candidate scopes: ${prior.key} and ${candidate.key}`);
      }
    }
    scoped.push({ key: candidate.key, scope: current });
    return Object.freeze({
      key: candidate.key, recordDigest: sha256({ record: candidate.record, resource: candidate.resource ?? null }),
      evidenceDigest: digestField(candidate.evidenceDigest, `${candidate.key}.evidenceDigest`),
      fixtureDigest: digestField(candidate.fixtureDigest, `${candidate.key}.fixtureDigest`),
      resource: candidate.resource ?? null,
    });
  });
  records.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  const candidateSetDigest = sha256(records);
  const manifest: AdmissionManifest = Object.freeze({
    schemaVersion: '1', candidateSetDigest, templateDigest, sourceReceiptDigests, records: Object.freeze(records),
  });
  return Object.freeze({ candidates: Object.freeze([...input.candidates]), manifest });
}

export function manifestDigest(manifest: AdmissionManifest): Digest {
  return sha256(manifest);
}

export function admitManifest(
  manifest: AdmissionManifest,
  receipt: BatchReviewReceipt,
  candidates: readonly BatchCandidate[],
  authorizedReviewers: readonly string[],
): AdmissionSuccess | AdmissionFailure {
  if (manifest.schemaVersion !== '1') return fail('INVALID_SCHEMA', 'manifest.schemaVersion');
  if (sha256(manifest.records) !== manifest.candidateSetDigest) return fail('MUTATED_MANIFEST', 'candidateSetDigest');
  if (receipt.schemaVersion !== '1') return fail('INVALID_SCHEMA', 'receipt.schemaVersion');
  if (receipt.decision !== 'APPROVED') return fail('NOT_APPROVED', 'receipt.decision');
  if (receipt.reviewer.trim().length === 0) return fail('INVALID_REVIEWER', 'receipt.reviewer');
  if (!authorizedReviewers.includes(receipt.reviewer)) return fail('UNAUTHORIZED_REVIEWER', 'receipt.reviewer');
  const reviewedAt = Date.parse(receipt.reviewedAt);
  if (!Number.isFinite(reviewedAt) || new Date(reviewedAt).toISOString() !== receipt.reviewedAt) return fail('INVALID_REVIEWED_AT', 'receipt.reviewedAt');
  if (receipt.manifestDigest !== manifestDigest(manifest)) return fail('MANIFEST_MISMATCH', 'receipt.manifestDigest');
  if (receipt.evidenceArtifactDigest !== manifest.candidateSetDigest) return fail('EVIDENCE_MISMATCH', 'receipt.evidenceArtifactDigest');
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  if (byKey.size !== candidates.length) return fail('DUPLICATE_CANDIDATE', 'candidates');
  const reviewReceiptDigest = sha256(receipt);
  const receipts: ModelAdmissionReceipt[] = [];
  for (const record of manifest.records) {
    const candidate = byKey.get(record.key);
    if (candidate === undefined) return fail('UNREVIEWED_KEY', record.key);
    if (sha256({ record: candidate.record, resource: candidate.resource ?? null }) !== record.recordDigest) return fail('MUTATED_RECORD', record.key);
    if (candidate.evidenceDigest !== record.evidenceDigest) return fail('EVIDENCE_MISMATCH', record.key);
    if (candidate.fixtureDigest !== record.fixtureDigest) return fail('FIXTURE_MISMATCH', record.key);
    receipts.push(Object.freeze({ key: record.key, recordDigest: record.recordDigest, manifestDigest: receipt.manifestDigest, reviewReceiptDigest }));
  }
  if (byKey.size !== manifest.records.length) return fail('UNREVIEWED_KEY', 'candidates');
  return Object.freeze({ ok: true, receipts: Object.freeze(receipts) });
}
