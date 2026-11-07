import { createHash } from 'node:crypto';

export const GOVERNANCE_SPLITS = ['development', 'holdout'];
export const GOVERNANCE_PROTOCOL = Object.freeze({
  tuningSplit: 'development',
  holdoutSplit: 'holdout',
  holdoutPolicy: 'untouched-evaluate-once',
  queryKey: 'query+filters+sort-v1',
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const valueOrNull = (value) => typeof value === 'string' ? value : null;

function canonicalFilters(filters) {
  if (filters === undefined) return {};
  if (!isRecord(filters)) return null;
  const entries = Object.entries(filters).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const normalized = {};
  for (const [key, value] of entries) {
    if (typeof value === 'string') normalized[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) normalized[key] = [...value].sort();
    else return null;
  }
  return normalized;
}

export function canonicalQueryKey(testCase) {
  if (!isRecord(testCase) || typeof testCase.query !== 'string'
    || !['relevance', 'quality'].includes(testCase.sort)) return null;
  const filters = canonicalFilters(testCase.filters);
  return filters === null ? null : JSON.stringify([testCase.query, filters, testCase.sort]);
}

export function querySetSha256(cases, split) {
  const keys = (Array.isArray(cases) ? cases : [])
    .filter((testCase) => testCase?.split === split)
    .map(canonicalQueryKey)
    .filter((key) => key !== null)
    .sort();
  return sha256(keys.join('\n'));
}

function validGeneratedAt(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validRelease(release) {
  return isRecord(release)
    && typeof release.releaseId === 'string' && release.releaseId.trim() === release.releaseId
    && typeof release.corpusId === 'string' && /^[^\s@]+$/.test(release.corpusId)
    && validGeneratedAt(release.generatedAt)
    && release.releaseId === `${release.corpusId}@${release.generatedAt}`
    && typeof release.corpusSha256 === 'string' && HASH_PATTERN.test(release.corpusSha256);
}

function protocolSummary(protocol) {
  if (!isRecord(protocol)) return null;
  return Object.fromEntries(Object.keys(GOVERNANCE_PROTOCOL).map((field) => [field, valueOrNull(protocol[field])]));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function validateSearchGovernance({ fixture, expectedReleaseId } = {}) {
  const errors = [];
  const add = (message) => errors.push(message);
  const object = isRecord(fixture);
  const release = object && isRecord(fixture.release) ? fixture.release : null;
  const releaseId = valueOrNull(release?.releaseId);
  const protocol = object ? fixture.protocol : null;
  const cases = object && Array.isArray(fixture.cases) ? fixture.cases : [];
  const bySplit = Object.fromEntries(GOVERNANCE_SPLITS.map((split) => [split, []]));

  if (!object) add('fixture must be an object');
  else {
    if (fixture.schemaVersion !== 'relevance-set-v2') add('fixture schemaVersion must be relevance-set-v2');
    if (!validRelease(release)) add('release identity is missing or invalid');
    if (expectedReleaseId !== undefined && expectedReleaseId !== releaseId) add('release identity does not match the expected release');
    if (!Array.isArray(fixture.cases)) add('fixture cases must be an array');
    if (!isRecord(protocol)) add('protocol is missing or malformed');
    else for (const [field, expected] of Object.entries(GOVERNANCE_PROTOCOL)) {
      if (protocol[field] !== expected) add(`protocol.${field} must be ${expected}`);
    }
  }

  const ids = new Set();
  for (const [index, testCase] of cases.entries()) {
    const label = typeof testCase?.id === 'string' && testCase.id.trim() ? testCase.id : `case[${index}]`;
    if (!isRecord(testCase)) { add(`${label} must be an object`); continue; }
    if (typeof testCase.id !== 'string' || !testCase.id.trim()) add(`${label} has a missing case ID`);
    else if (ids.has(testCase.id)) add(`${label} duplicates a case ID`);
    else ids.add(testCase.id);
    if (!GOVERNANCE_SPLITS.includes(testCase.split)) add(`${label} has an invalid protocol split`);
    else bySplit[testCase.split].push({ id: label, key: canonicalQueryKey(testCase) });
    if (typeof testCase.query !== 'string' || canonicalFilters(testCase.filters) === null) add(`${label} has invalid canonical query fields`);
    if (!['relevance', 'quality'].includes(testCase.sort)) add(`${label} has an invalid sort`);
  }
  for (const split of GOVERNANCE_SPLITS) if (bySplit[split].length === 0) add(`fixture missing ${split} split`);

  const queryOwners = new Map();
  for (const split of GOVERNANCE_SPLITS) for (const entry of bySplit[split]) {
    if (entry.key === null) continue;
    const owners = queryOwners.get(entry.key) ?? [];
    owners.push({ ...entry, split });
    queryOwners.set(entry.key, owners);
  }
  for (const owners of [...queryOwners.values()].sort((left, right) => left[0].key < right[0].key ? -1 : 1)) {
    const splits = [...new Set(owners.map((owner) => owner.split))].sort();
    const labels = owners.map((owner) => owner.id).sort().join(', ');
    if (splits.length > 1) add(`canonical query key contamination between development and holdout (${labels})`);
    else if (owners.length > 1) add(`duplicate canonical query key in ${splits[0]} (${labels})`);
  }

  const hashes = {};
  for (const split of GOVERNANCE_SPLITS) {
    const field = `${split}QuerySetSha256`;
    const computed = querySetSha256(cases, split);
    const declared = valueOrNull(protocol?.[field]);
    const matches = HASH_PATTERN.test(declared ?? '') && declared === computed;
    hashes[split] = { declared, computed, matches };
    if (!HASH_PATTERN.test(declared ?? '')) add(`protocol.${field} is missing or malformed`);
    else if (!matches) add(`protocol.${field} is stale`);
  }

  const report = {
    ok: errors.length === 0,
    schemaVersion: valueOrNull(fixture?.schemaVersion),
    releaseId,
    releaseValid: validRelease(release),
    protocol: protocolSummary(protocol),
    splits: Object.fromEntries(GOVERNANCE_SPLITS.map((split) => [split, {
      cases: bySplit[split].length,
      querySetSha256: hashes[split].computed,
    }])),
    hashes,
    errors: sortedUnique(errors),
  };
  return report;
}
