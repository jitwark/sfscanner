import { canonical, sha } from './maintenance-identity.mjs';

export const APPROVED_FIXTURE_PATH = 'app/src/search/__fixtures__/relevance-set.json';
export const REQUIRED_SEARCH_ARTIFACTS = Object.freeze([
  'search-index.json', 'search-index-extended.json', 'facets.json', 'semantic-index.json',
]);
export const HELPER_PATHS = Object.freeze([
  'scripts/lib/search-release-binding.mjs',
  'scripts/lib/search-release-contract.mjs',
  'scripts/lib/search-release-data.mjs',
  'scripts/lib/search-release-rollback.mjs',
  'scripts/lib/search-release-index.mjs',
]);
export const BINDING_RECEIPT_SCHEMA = 'search-release-binding-receipt-v2';
export const FILTERS = Object.freeze({
  rights: 'rights', grade: 'grade', trigger: 'trigger', complexity: 'complexity',
  capability: 'capability', integration: 'integration', tag: 'tag',
});
export const sha256 = sha;
export const canonicalJson = canonical;
const HASH = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9_-])?$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const KINDS = new Set(['exact', 'navigational', 'facet', 'natural-language', 'alias', 'misspelling', 'zero-result', 'ambiguous']);
const STRATA = new Set(['official', 'link-only', 'redistributable', 'common', 'rare', 'safe', 'risky']);

export function fail(message) {
  throw new Error(`search release binding refused: ${message}`);
}

export function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unknown or missing keys`);
  }
  return value;
}

export function text(value, label, max = 16384) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be safe non-empty text`);
  }
  return value;
}

export function string(value, label, max = 16384) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be safe text`);
  }
  return value;
}

export function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

export function count(value, label, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(`${label} must be a ${positive ? 'positive' : 'non-negative'} integer`);
  }
  return value;
}

export function utc(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) {
    fail(`${label} must be canonical UTC`);
  }
  return value;
}

export function normalizeFacetValue(filter, value) {
  if (!FILTERS[filter]) fail(`unsupported filter ${filter}`);
  const raw = text(value, `filter ${filter}`, 256);
  if (filter === 'grade') return raw.toUpperCase();
  const normalized = raw.trim().toLowerCase().replace(/\s+/gu, '-');
  if (!normalized) fail(`filter ${filter} must normalize to a non-empty value`);
  if (filter === 'rights') {
    const rights = normalized.replaceAll('_', '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
    if (rights === 'link-only' || rights === 'linkonly') return 'link_only';
  }
  return normalized;
}

export const normalizeFilterKey = (filter, value) => `${filter}:${normalizeFacetValue(filter, value)}`;

function caseKey(item) {
  const filters = Object.fromEntries(Object.entries(item.filters ?? {})
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]));
  return JSON.stringify([item.query, filters, item.sort]);
}

const querySetSha256 = (cases, split) => sha256(Buffer.from(cases
  .filter((item) => item.split === split).map(caseKey).sort().join('\n')));

function releaseValue(value, label) {
  const release = keys(value, ['releaseId', 'corpusId', 'generatedAt', 'corpusSha256', 'manifestSha256', 'searchable', 'artifacts'], label);
  text(release.corpusId, `${label}.corpusId`, 128);
  utc(release.generatedAt, `${label}.generatedAt`);
  if (release.releaseId !== `${release.corpusId}@${release.generatedAt}`) fail(`${label}.releaseId is inconsistent`);
  digest(release.corpusSha256, `${label}.corpusSha256`);
  digest(release.manifestSha256, `${label}.manifestSha256`);
  count(release.searchable, `${label}.searchable`, true);
  const artifacts = keys(release.artifacts, REQUIRED_SEARCH_ARTIFACTS, `${label}.artifacts`);
  for (const name of REQUIRED_SEARCH_ARTIFACTS) digest(artifacts[name], `${label}.artifacts.${name}`);
}

export function readRelevanceFixture(value) {
  const fixture = keys(value, ['schemaVersion', 'createdOn', 'reviewers', 'release', 'protocol', 'cases'], 'fixture');
  if (fixture.schemaVersion !== 'relevance-set-v2' || !/^\d{4}-\d{2}-\d{2}$/u.test(fixture.createdOn)) fail('fixture schema or createdOn is invalid');
  if (!Array.isArray(fixture.reviewers) || fixture.reviewers.length < 2 || new Set(fixture.reviewers).size !== fixture.reviewers.length) fail('fixture reviewers are invalid');
  fixture.reviewers.forEach((item, index) => text(item, `fixture.reviewers[${index}]`, 256));
  releaseValue(fixture.release, 'fixture.release');
  const protocol = keys(fixture.protocol, [
    'tuningSplit', 'holdoutSplit', 'holdoutPolicy', 'queryKey', 'developmentQuerySetSha256', 'holdoutQuerySetSha256',
  ], 'fixture.protocol');
  if (protocol.tuningSplit !== 'development' || protocol.holdoutSplit !== 'holdout' ||
      protocol.holdoutPolicy !== 'untouched-evaluate-once' || protocol.queryKey !== 'query+filters+sort-v1') fail('fixture protocol is invalid');
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) fail('fixture.cases must be a non-empty array');
  const caseIds = new Set(); const querySplits = new Map(); const kinds = new Set(); const strata = new Set();
  for (const [index, raw] of fixture.cases.entries()) {
    const allowed = ['id', 'split', 'kind', 'sort', 'query', 'filters', 'strata', 'expected', 'adjudication'];
    const item = keys(raw, allowed.filter((key) => key in raw), `fixture.cases[${index}]`);
    const id = text(item.id, `fixture.cases[${index}].id`, 256);
    if (caseIds.has(id)) fail(`duplicate case ID ${id}`);
    caseIds.add(id);
    if (!['development', 'holdout'].includes(item.split) || !KINDS.has(item.kind) || !['relevance', 'quality'].includes(item.sort)) fail(`${id} has an invalid split, kind, or sort`);
    string(item.query, `${id}.query`);
    if (!Array.isArray(item.strata) || !item.strata.length) fail(`${id}.strata is invalid`);
    item.strata.forEach((stratum) => { if (!STRATA.has(stratum)) fail(`${id} has an invalid stratum`); strata.add(stratum); });
    kinds.add(item.kind);
    const query = caseKey(item); const previous = querySplits.get(query);
    if (previous && previous !== item.split) fail(`${id} contaminates development/holdout queries`);
    querySplits.set(query, item.split);
    if ('filters' in item) {
      if (!item.filters || typeof item.filters !== 'object' || Array.isArray(item.filters)) fail(`${id}.filters is invalid`);
      for (const [filter, filterValue] of Object.entries(item.filters)) {
        for (const entry of Array.isArray(filterValue) ? filterValue : [filterValue]) normalizeFacetValue(filter, entry);
      }
    }
    if (!Array.isArray(item.expected)) fail(`${id}.expected is invalid`);
    const expectedIds = new Set();
    for (const [position, rawJudgment] of item.expected.entries()) {
      const judgment = keys(rawJudgment, ['id', 'relevance', 'rationale', 'reviewer', 'reviewedOn', 'releaseId'], `${id}.expected[${position}]`);
      text(judgment.id, `${id}.expected[${position}].id`, 256);
      if (expectedIds.has(judgment.id)) fail(`${id} repeats expected ID ${judgment.id}`);
      expectedIds.add(judgment.id);
      if (![1, 2, 3].includes(judgment.relevance)) fail(`${id} has invalid relevance`);
      text(judgment.rationale, `${id}.rationale`); text(judgment.reviewer, `${id}.reviewer`, 256);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(judgment.reviewedOn) || judgment.releaseId !== fixture.release.releaseId) fail(`${id} has an incomplete or stale judgment`);
    }
    if (item.kind === 'zero-result' ? item.expected.length !== 0 : item.expected.length === 0) fail(`${id} judgment count contradicts its kind`);
    if (item.kind === 'ambiguous') {
      const adjudication = keys(item.adjudication, ['status', 'reviewers', 'decision'], `${id}.adjudication`);
      if (adjudication.status !== 'adjudicated' || !Array.isArray(adjudication.reviewers) || adjudication.reviewers.length < 2) fail(`${id} lacks adjudication`);
      text(adjudication.decision, `${id}.adjudication.decision`);
    }
  }
  for (const kind of KINDS) if (!kinds.has(kind)) fail(`fixture lacks ${kind} cases`);
  for (const stratum of STRATA) if (!strata.has(stratum)) fail(`fixture lacks ${stratum} strata`);
  if (!fixture.cases.some((item) => item.split === 'development') || !fixture.cases.some((item) => item.split === 'holdout')) fail('fixture lacks a split');
  if (protocol.developmentQuerySetSha256 !== querySetSha256(fixture.cases, 'development') ||
      protocol.holdoutQuerySetSha256 !== querySetSha256(fixture.cases, 'holdout')) fail('fixture query-set hashes are stale');
  return fixture;
}

export function cohortSha256(value) {
  const fixture = readRelevanceFixture(value);
  const { release: _release, ...governance } = fixture;
  const projection = {
    ...governance,
    cases: fixture.cases.map(({ expected, ...item }) => ({
      ...item, expected: expected.map(({ releaseId: _releaseId, ...judgment }) => judgment),
    })),
  };
  return sha256(Buffer.from(canonicalJson(projection)));
}

const keyed = (value) => value && typeof value === 'object' ? Array.isArray(value) ? value.map((_item, index) => String(index)) : Object.keys(value) : [];
function changedPointers(left, right, pointer = '', rows = []) {
  if (left === right || canonicalJson(left) === canonicalJson(right)) return rows;
  const fields = new Set([...keyed(left), ...keyed(right)]);
  if (!fields.size) { rows.push({ pointer, before: left, after: right }); return rows; }
  for (const field of [...fields].sort()) {
    changedPointers(left?.[field], right?.[field], `${pointer}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`, rows);
  }
  return rows;
}
const allowedPointer = (pointer) => /^\/release\/(?:releaseId|corpusId|generatedAt|corpusSha256|manifestSha256|searchable)$/u.test(pointer) ||
  /^\/release\/artifacts\/[^/]+$/u.test(pointer) || /^\/cases\/\d+\/expected\/\d+\/releaseId$/u.test(pointer);
export function semanticFieldDiff(before, after) {
  const left = readRelevanceFixture(before); const right = readRelevanceFixture(after);
  if (cohortSha256(left) !== cohortSha256(right)) fail('semantic cohort changed outside the release allowlist');
  const diff = changedPointers(left, right).filter((item) => item.before !== item.after);
  const rejected = diff.filter((item) => !allowedPointer(item.pointer));
  if (rejected.length) fail(`semantic diff contains a pointer outside the release allowlist: ${rejected.map((item) => item.pointer).join(', ')}`);
  return diff;
}

export function transactionValue(value) {
  const item = keys(value, ['id', 'planSha256', 'attempt'], 'transaction');
  if (typeof item.id !== 'string' || !TRANSACTION_ID.test(item.id) || WINDOWS_RESERVED.test(item.id)) {
    fail('transaction.id is invalid');
  }
  digest(item.planSha256, 'transaction.planSha256');
  count(item.attempt, 'transaction.attempt', true);
  return { id: item.id, planSha256: item.planSha256, attempt: item.attempt };
}

function dataIdentityValue(value, label) {
  const identity = keys(value, ['manifestSha256', 'totalEntries', 'artifacts', 'treeSha256', 'fileCount'], label);
  digest(identity.manifestSha256, `${label}.manifestSha256`);
  digest(identity.treeSha256, `${label}.treeSha256`);
  count(identity.totalEntries, `${label}.totalEntries`);
  count(identity.fileCount, `${label}.fileCount`, true);
  if (!Array.isArray(identity.artifacts)) fail(`${label}.artifacts must be an array`);
  identity.artifacts.forEach((artifact, index) => {
    const row = keys(artifact, ['path', 'byteSize', 'sha256'], `${label}.artifacts[${index}]`);
    text(row.path, `${label}.artifacts[${index}].path`, 1024);
    count(row.byteSize, `${label}.artifacts[${index}].byteSize`); digest(row.sha256, `${label}.artifacts[${index}].sha256`);
  });
}

export function receiptValue(value) {
  const receipt = keys(value, ['schemaVersion', 'approvedPaths', 'helper', 'transaction', 'baseline', 'generated', 'fieldDiff'], 'receipt');
  if (receipt.schemaVersion !== BINDING_RECEIPT_SCHEMA || canonicalJson(receipt.approvedPaths) !== canonicalJson([APPROVED_FIXTURE_PATH])) fail('receipt schema or approved paths are invalid');
  if (!Array.isArray(receipt.helper) || receipt.helper.length !== HELPER_PATHS.length) fail('receipt helper inventory is invalid');
  receipt.helper.forEach((item, index) => {
    const helper = keys(item, ['path', 'sha256'], `receipt.helper[${index}]`);
    if (helper.path !== HELPER_PATHS[index]) fail('receipt helper order is invalid');
    digest(helper.sha256, `receipt.helper[${index}].sha256`);
  });
  transactionValue(receipt.transaction);
  const baseline = keys(receipt.baseline, ['fixtureSha256', 'cohortSha256', 'dataIdentity'], 'receipt.baseline');
  const generated = keys(receipt.generated, ['fixtureSha256', 'cohortSha256', 'release', 'dataIdentity'], 'receipt.generated');
  for (const [name, item] of [['baseline', baseline], ['generated', generated]]) {
    digest(item.fixtureSha256, `receipt.${name}.fixtureSha256`); digest(item.cohortSha256, `receipt.${name}.cohortSha256`);
    dataIdentityValue(item.dataIdentity, `receipt.${name}.dataIdentity`);
  }
  releaseValue(generated.release, 'receipt.generated.release');
  if (!Array.isArray(receipt.fieldDiff) || receipt.fieldDiff.some((item) => keys(item, ['pointer', 'before', 'after'], 'receipt field diff') && !allowedPointer(item.pointer))) fail('receipt field diff is invalid');
  return receipt;
}
