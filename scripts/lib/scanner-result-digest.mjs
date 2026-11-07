import { createHash } from 'node:crypto';

/**
 * The shipped catalogue's scanner results as data: the canonical JSON encoding
 * the freshness digest is taken over, the count in each rights scope, and the
 * digest itself.
 *
 * The digest is what binds 11,464 published security verdicts to the record in
 * `scripts/scanner-result-freshness.json`: regenerating the verdicts without
 * updating the record changes the digest, and the gate fails. It covers the
 * redistributable entries only, because those are the ones with an authorized
 * body that can be rescanned.
 *
 * `scanner-result-freshness.mjs` owns the audit that compares the record
 * against these measurements.
 */

/** A JSON object: not null, not an array, not a primitive. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON: sorted object keys, input array order, no locale collation. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot encode non-finite number as canonical JSON');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object' || value === undefined) throw new TypeError(`Cannot encode ${typeof value} as canonical JSON`);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const pairs = Object.keys(value)
    .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${pairs.join(',')}}`;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const RESULTS_DIGEST_PREFIX = 'sha256:';

/** The results this record binds: every redistributable entry and its `security`. */
export function boundResults(entries) {
  return entries
    .filter((entry) => entry?.rights?.status === 'redistributable')
    .map((entry) => ({ id: entry.id, security: entry.security }));
}

export function resultsDigest(entries) {
  return `${RESULTS_DIGEST_PREFIX}${sha256Hex(canonicalJson(boundResults(entries)))}`;
}

export function scopeCounts(entries) {
  let redistributable = 0;
  let linkOnly = 0;
  for (const entry of entries) {
    if (entry?.rights?.status === 'redistributable') redistributable += 1;
    else if (entry?.rights?.status === 'link_only') linkOnly += 1;
  }
  return { total: entries.length, redistributable, linkOnly };
}
