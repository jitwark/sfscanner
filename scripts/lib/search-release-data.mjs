import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataIdentity, safePath } from './maintenance-identity.mjs';
import {
  APPROVED_FIXTURE_PATH, HELPER_PATHS, REQUIRED_SEARCH_ARTIFACTS,
  count, digest, fail, normalizeFilterKey, sha256, text, utc,
} from './search-release-contract.mjs';
import { validateSearchIndexArtifact } from './search-release-index.mjs';

const MODULE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
// Canonical worker limit from contracts/artifact-validation.ts.
const MAX_SEARCH_INDEX_JSON_CHARS = 25 * 1024 * 1024;

const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function required(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} is required`);
  return value;
}

export function resolveSearchReleasePaths({ candidateRoot, baselineCandidateRoot, receiptRoot, receiptPath }) {
  required(candidateRoot, 'candidateRoot'); required(baselineCandidateRoot, 'baselineCandidateRoot');
  required(receiptRoot, 'receiptRoot'); required(receiptPath, 'receiptPath');
  const candidate = safePath(candidateRoot, 'candidate root', { kind: 'directory' });
  const baseline = safePath(baselineCandidateRoot, 'baseline root', { kind: 'directory' });
  const safeReceiptRoot = safePath(receiptRoot, 'receipt root', { kind: 'directory' });
  const candidateData = safePath(path.join(candidate, 'data'), 'candidate data', { kind: 'directory' });
  const baselineData = safePath(path.join(baseline, 'data'), 'baseline data', { kind: 'directory' });
  const candidateFixture = safePath(path.join(candidate, APPROVED_FIXTURE_PATH), 'candidate fixture', { kind: 'file' });
  const baselineFixture = safePath(path.join(baseline, APPROVED_FIXTURE_PATH), 'baseline fixture', { kind: 'file' });
  const receipt = safePath(receiptPath, 'receipt', { missing: true });
  if (existsSync(receipt) && !lstatSync(receipt).isFile()) fail('receipt must be a regular file');
  if (samePath(candidate, baseline)) fail('candidate and baseline roots must be distinct');
  if (samePath(candidateData, baselineData) || samePath(candidateFixture, baselineFixture)) fail('candidate and baseline data/fixtures must be distinct');
  if (!inside(safeReceiptRoot, receipt)) fail('receipt must be under the explicit receipt root');
  for (const [label, target] of [
    ['candidate data', candidateData], ['baseline data', baselineData],
    ['candidate fixture directory', path.dirname(candidateFixture)], ['baseline fixture directory', path.dirname(baselineFixture)],
  ]) if (samePath(target, receipt) || inside(target, receipt)) fail(`receipt must be outside mutable ${label}`);
  for (const [label, target] of [['candidate data', candidateData], ['baseline data', baselineData]]) {
    if (samePath(target, safeReceiptRoot) || inside(target, safeReceiptRoot)) fail(`receipt root must be outside mutable ${label}`);
  }
  return { candidate, baseline, candidateData, baselineData, candidateFixture, baselineFixture, receiptRoot: safeReceiptRoot, receipt };
}

export function readDataIdentity(root, label = 'data tree') {
  const safeRoot = safePath(root, `${label} root`, { kind: 'directory' });
  safePath(path.join(safeRoot, 'data'), label, { kind: 'directory' });
  return dataIdentity(safeRoot);
}

export function helperSourceIdentity() {
  return HELPER_PATHS.map((relative) => {
    const file = safePath(path.join(MODULE_ROOT, relative), `helper ${relative}`, { kind: 'file' });
    return { path: relative, sha256: sha256(readFileSync(file)) };
  });
}

export function transactionValueFrom(receipt) {
  return { id: receipt.transaction.id, planSha256: receipt.transaction.planSha256, attempt: receipt.transaction.attempt };
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is not a safe search ID`);
  return value;
}

function json(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} is not valid JSON`); }
}

function indexJson(bytes, label) {
  const value = bytes.toString('utf8');
  if (value.length > MAX_SEARCH_INDEX_JSON_CHARS) fail(`Malformed ${label}: payload is too large`);
  try { return JSON.parse(value); } catch { fail(`${label} is not valid JSON`); }
}

function indexRecords(value, label) {
  const parsed = validateSearchIndexArtifact(value, label);
  return parsed.documentIds.map((documentId, index) => id(documentId, `${label}.documentIds[${index}]`));
}

function decodeBitset(value, total, key) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) fail(`facet ${key} has an invalid canonical bitset`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(`facet ${key} has a noncanonical bitset`);
  const expected = Math.ceil(total / 32) * 4;
  if (bytes.length !== expected) fail(`facet ${key} bitset length is invalid`);
  const words = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = bytes.readUInt32LE(offset); words.push(word);
    const paddingStart = total % 32;
    if (paddingStart !== 0 && offset === bytes.length - 4) {
      const allowed = (2 ** paddingStart) - 1;
      if ((word & ~allowed) !== 0) fail(`facet ${key} sets an ordinal outside the effective universe`);
    }
  }
  return words;
}

function contains(words, ordinal) {
  return ((words[ordinal >> 5] ?? 0) & (1 << (ordinal & 31))) !== 0;
}

function parseFacets(value, label) {
  const facets = object(value, label);
  const total = count(facets.total, `${label}.total`, true);
  if (!Array.isArray(facets.ordinals) || facets.ordinals.length !== total) fail(`${label} ordinals/total are inconsistent`);
  const ordinals = facets.ordinals.map((entry, index) => id(entry, `${label}.ordinals[${index}]`));
  if (new Set(ordinals).size !== ordinals.length) fail(`${label} ordinals contain ambiguous duplicate IDs`);
  const rawBitsets = object(facets.bitsets, `${label}.bitsets`);
  const bitsets = new Map();
  for (const [key, encoded] of Object.entries(rawBitsets)) {
    text(key, `${label} bitset key`, 512);
    bitsets.set(key, decodeBitset(encoded, total, key));
  }
  return { total, ordinals, bitsets };
}

function parseSemantic(value, label) {
  const semantic = object(value, label);
  if (semantic.version !== 1 || semantic.dimensions !== 96 || !Array.isArray(semantic.documents) || semantic.documents.length === 0) fail(`${label} header is invalid`);
  if (!Array.isArray(semantic.ordinals)) fail(`${label}.ordinals is invalid`);
  const ordinals = semantic.ordinals.map((entry, index) => id(entry, `${label}.ordinals[${index}]`));
  if (new Set(ordinals).size !== ordinals.length) fail(`${label}.ordinals contain ambiguous duplicate IDs`);
  const documents = new Map();
  for (const [index, raw] of semantic.documents.entries()) {
    const item = object(raw, `${label}.documents[${index}]`);
    const documentId = id(item.id, `${label}.documents[${index}].id`);
    if (documents.has(documentId)) fail(`${label} contains ambiguous duplicate ID ${documentId}`);
    if (!Array.isArray(item.vector) || item.vector.length !== 96 || item.vector.some((entry) => !Number.isFinite(entry))) fail(`${label} vector ${documentId} is invalid`);
    documents.set(documentId, item.vector);
  }
  return { ordinals, documents };
}

export function deriveSearchRelease({ candidateRoot }) {
  const root = safePath(required(candidateRoot, 'candidateRoot'), 'candidate root', { kind: 'directory' });
  const data = safePath(path.join(root, 'data'), 'candidate data', { kind: 'directory' });
  const bytes = Object.fromEntries(REQUIRED_SEARCH_ARTIFACTS.map((name) => [name, readFileSync(path.join(data, name))]));
  const manifestBytes = readFileSync(path.join(data, 'manifest.json'));
  const manifest = object(json(manifestBytes, 'manifest'), 'manifest');
  if (manifest.schemaVersion !== 'manifest-v1' || !Array.isArray(manifest.artifacts)) fail('manifest schema is invalid');
  count(manifest.totalEntries, 'manifest.totalEntries'); count(manifest.artifacts.length, 'manifest.artifacts');
  const metadata = object(manifest.metadata, 'manifest.metadata');
  const corpusId = text(metadata.corpusId, 'manifest.metadata.corpusId', 128);
  const generatedAt = metadata.generatedAt;
  if (manifest.generatedAt !== generatedAt) fail('manifest generatedAt disagrees with metadata');
  const corpusSha256 = digest(metadata.corpusSha256, 'manifest.metadata.corpusSha256');
  const artifacts = {};
  for (const name of REQUIRED_SEARCH_ARTIFACTS) {
    const matches = manifest.artifacts.filter((item) => item?.path === name);
    const row = matches[0];
    if (matches.length !== 1 || row.byteSize !== bytes[name].length || row.sha256 !== sha256(bytes[name])) fail(`manifest artifact binding is invalid: ${name}`);
    artifacts[name] = sha256(bytes[name]);
  }
  const primaryIds = indexRecords(indexJson(bytes['search-index.json'], 'primary index'), 'primary index');
  const extendedIds = indexRecords(indexJson(bytes['search-index-extended.json'], 'extended index'), 'extended index');
  const facets = parseFacets(json(bytes['facets.json'], 'facets'), 'facets');
  const semantic = parseSemantic(json(bytes['semantic-index.json'], 'semantic index'), 'semantic index');
  const allRecords = [...primaryIds, ...extendedIds];
  const records = new Set();
  for (const documentId of allRecords) {
    if (records.has(documentId)) fail(`ambiguous searchable ID appears in more than one record: ${documentId}`);
    records.add(documentId);
  }
  const implicit = semantic.ordinals.length ? semantic.ordinals : primaryIds;
  const base = facets.ordinals.length ? facets.ordinals : implicit;
  const known = new Set(base);
  if (known.size !== base.length) fail('facet/semantic/primary ordinal selection is ambiguous');
  const appended = extendedIds.filter((documentId) => !known.has(documentId));
  const ordinals = [...base, ...appended];
  const ordinalById = new Map(ordinals.map((documentId, ordinal) => [documentId, ordinal]));
  if (ordinalById.size !== ordinals.length) fail('effective ordinal universe is ambiguous');
  for (const documentId of ordinals) if (!records.has(documentId)) fail(`effective ordinal is unhydrated: ${documentId}`);
  for (const documentId of records) if (!ordinalById.has(documentId)) fail(`searchable record is orphaned from the effective ordinal universe: ${documentId}`);
  for (const documentId of semantic.documents.keys()) if (!records.has(documentId)) fail(`semantic vector is orphaned from searchable records: ${documentId}`);
  for (const documentId of semantic.ordinals) if (!records.has(documentId)) fail(`semantic ordinal is orphaned from searchable records: ${documentId}`);
  if (facets.total !== ordinals.length) fail(`facets.total ${facets.total} is incompatible with effective ordinal count ${ordinals.length}`);
  const release = {
    releaseId: `${corpusId}@${generatedAt}`, corpusId, generatedAt: utc(generatedAt, 'manifest.metadata.generatedAt'),
    corpusSha256, manifestSha256: sha256(manifestBytes), searchable: ordinals.length, artifacts,
  };
  return {
    release, ids: [...records], ordinals, effectiveOrdinalCount: ordinals.length, ordinalById,
    facetKeys: [...facets.bitsets.keys()].sort(), bitsets: facets.bitsets, dataIdentity: dataIdentity(root),
  };
}

export function validateJudgments(fixture, derived) {
  for (const item of fixture.cases) {
    for (const [filter, raw] of Object.entries(item.filters ?? {})) {
      const values = Array.isArray(raw) ? raw : [raw];
      if (values.length === 0) continue;
      const facetKeys = values.map((value) => normalizeFilterKey(filter, value));
      for (const key of facetKeys) if (!derived.bitsets.has(key)) fail(`${item.id} facet is missing from candidate: ${key}`);
      if (item.expected.length > 0) {
        for (const judgment of item.expected) {
          if (!derived.ordinalById.has(judgment.id)) fail(`${item.id} judged ID is not hydrated: ${judgment.id}`);
          const ordinal = derived.ordinalById.get(judgment.id);
          if (!facetKeys.some((key) => contains(derived.bitsets.get(key), ordinal))) {
            fail(`${item.id} judged ID ${judgment.id} is not eligible in filter ${filter}=${values.join(',')}`);
          }
        }
      }
    }
    for (const judgment of item.expected) {
      if (!derived.ordinalById.has(judgment.id)) fail(`${item.id} judged ID is not hydrated: ${judgment.id}`);
    }
  }
}
