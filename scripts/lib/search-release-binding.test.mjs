import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SEARCH_ARTIFACT_CHARS } from '../../contracts/artifact-validation.ts';
import { parseSearchIndexArtifact, parseSearchIndexJson } from '../../contracts/search-index-artifact.ts';
import { SEARCH_FIELDS, SEARCH_STORE_FIELDS } from '../../contracts/search-config.ts';
import { dataIdentity } from './maintenance-identity.mjs';
import {
  APPROVED_FIXTURE_PATH, BINDING_RECEIPT_SCHEMA, HELPER_PATHS, REQUIRED_SEARCH_ARTIFACTS,
  cohortSha256, normalizeFilterKey, readRelevanceFixture, semanticFieldDiff,
} from './search-release-contract.mjs';
import { deriveSearchRelease, resolveSearchReleasePaths } from './search-release-data.mjs';
import { bindSearchRelease, verifySearchReleaseReceipt } from './search-release-binding.mjs';
import { rollbackSearchReleaseBinding } from './search-release-rollback.mjs';
import { validateSearchIndexArtifact } from './search-release-index.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (file, value) => writeFileSync(file, stableJson(value));
const artifactPath = (root, name) => path.join(root, 'data', name);
const fixturePath = (root) => path.join(root, APPROVED_FIXTURE_PATH);
const transaction = Object.freeze({ id: 'run-2026-10-31', planSha256: 'a'.repeat(64), attempt: 1 });
const KINDS = ['exact', 'navigational', 'facet', 'natural-language', 'alias', 'misspelling', 'zero-result', 'ambiguous'];
const STRATA = ['official', 'link-only', 'redistributable', 'common', 'rare', 'safe', 'risky'];
const authentic = readRelevanceFixture(JSON.parse(readFileSync(new URL('../../app/src/search/__fixtures__/relevance-set.json', import.meta.url), 'utf8')));

function caseKey(testCase) {
  const filters = Object.fromEntries(Object.entries(testCase.filters ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]));
  return JSON.stringify([testCase.query, filters, testCase.sort]);
}
const querySetSha256 = (cases, split) => sha256(cases.filter((item) => item.split === split).map(caseKey).sort().join('\n'));

function makeCases() {
  const filters = [
    { integration: ['slack', 'google-sheets'] }, { grade: 'LOW' }, { integration: 'slack', grade: 'low' },
    { rights: 'link-only' }, { trigger: 'manual' }, { complexity: 'simple' }, undefined, { capability: 'ai' },
  ];
  return KINDS.map((kind, index) => ({
    id: `${kind}-${index % 2 === 0 ? 'development' : 'holdout'}`,
    split: index % 2 === 0 ? 'development' : 'holdout', kind,
    sort: index % 2 === 0 ? 'relevance' : 'quality',
    query: kind === 'facet' ? '' : `query ${kind}`,
    ...(filters[index] ? { filters: filters[index] } : {}), strata: [STRATA[index % STRATA.length]],
    expected: kind === 'zero-result' ? [] : [{
      id: ['workflow-a', 'workflow-b', 'workflow-c'][index % 3], relevance: 3,
      rationale: `Judgment ${index}`, reviewer: 'reviewer-a', reviewedOn: '2026-10-30', releaseId: 'baseline@2026-10-29T00:00:00.000Z',
    }],
    ...(kind === 'ambiguous' ? { adjudication: { status: 'adjudicated', reviewers: ['reviewer-a', 'reviewer-b'], decision: 'resolved' } } : {}),
  }));
}

function fakeRelease(corpusId, generatedAt) {
  return {
    releaseId: `${corpusId}@${generatedAt}`, corpusId, generatedAt,
    corpusSha256: 'd'.repeat(64), manifestSha256: 'e'.repeat(64), searchable: 3,
    artifacts: Object.fromEntries(REQUIRED_SEARCH_ARTIFACTS.map((name) => [name, 'f'.repeat(64)])),
  };
}

function makeFixture(release, cases) {
  const rebound = structuredClone(cases).map((item) => ({
    ...item, expected: item.expected.map((judgment) => ({ ...judgment, releaseId: release.releaseId })),
  }));
  return {
    schemaVersion: 'relevance-set-v2', createdOn: '2026-09-01', reviewers: ['reviewer-a', 'reviewer-b'], release,
    protocol: {
      tuningSplit: 'development', holdoutSplit: 'holdout', holdoutPolicy: 'untouched-evaluate-once', queryKey: 'query+filters+sort-v1',
      developmentQuerySetSha256: querySetSha256(rebound, 'development'), holdoutQuerySetSha256: querySetSha256(rebound, 'holdout'),
    },
    cases: rebound,
  };
}

function encodeBitset(total, indices) {
  const bytes = Buffer.alloc(Math.ceil(total / 32) * 4);
  for (const index of indices) {
    const wordOffset = (index >> 5) * 4;
    bytes.writeUInt32LE((bytes.readUInt32LE(wordOffset) | (1 << (index & 31))) >>> 0, wordOffset);
  }
  return bytes.toString('base64');
}

function workerSlug(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, '-').replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-').replace(/^-|-$/gu, '');
}

function workerFacetKey(filter, value) {
  const slug = workerSlug(value);
  if (filter === 'grade') return `grade:${slug.toUpperCase()}`;
  if (filter === 'rights') return `rights:${slug === 'link-only' || slug === 'linkonly' ? 'link_only' : slug}`;
  return `${filter}:${slug}`;
}

function searchDocument(id, label) {
  return {
    id, slug: `slug-${id}`, title: `Workflow ${id}`, summary: `Summary for ${id} in ${label}`,
    tags: ['automation'], integrations: ['slack', 'google-sheets'], triggers: ['manual'],
    capabilities: ['code', 'ai'], grade: 'LOW', rights: 'link_only', complexity: 'simple',
    nodeCount: 1, sourceRepo: 'owner/repo', descriptionSource: 'upstream',
    isIndexable: true, isPrerendered: false, content: `Searchable workflow ${id} automation`,
  };
}

function indexArtifact(ids, label) {
  const index = new MiniSearch({
    fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS],
  });
  index.addAll(ids.map((id) => searchDocument(id, label)));
  return JSON.parse(JSON.stringify(index));
}

function writeData(root, mode, cases) {
  const data = path.join(root, 'data');
  mkdirSync(data, { recursive: true });
  const ids = [...new Set(cases.flatMap((item) => item.expected.map((judgment) => judgment.id)))];
  const selected = new Map();
  for (const testCase of cases) for (const [filter, raw] of Object.entries(testCase.filters ?? {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const key = workerFacetKey(filter, value);
      const ordinals = selected.get(key) ?? new Set();
      for (const judgment of testCase.expected) ordinals.add(ids.indexOf(judgment.id));
      selected.set(key, ordinals);
    }
  }
  const artifacts = {
    'search-index.json': Buffer.from(stableJson(indexArtifact(ids, mode))),
    'search-index-extended.json': Buffer.from(stableJson(indexArtifact([], `${mode}-extended`))),
    'facets.json': Buffer.from(stableJson({
      total: ids.length,
      counts: { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} },
      facets: [], bitsets: Object.fromEntries([...selected].map(([key, ordinals]) => [key, encodeBitset(ids.length, ordinals)])), ordinals: ids,
    })),
    'semantic-index.json': Buffer.from(stableJson({
      version: 1, dimensions: 96, ordinals: [],
      documents: ids.map((id) => ({ id, vector: Array(96).fill(mode === 'candidate' ? 0.5 : 0.25) })),
    })),
  };
  for (const [name, bytes] of Object.entries(artifacts)) writeFileSync(artifactPath(root, name), bytes);
  const generatedAt = mode === 'candidate' ? '2026-10-31T01:02:03.000Z' : '2026-10-26T00:00:00.000Z';
  const metadata = { corpusId: mode === 'candidate' ? 'data-v2' : 'baseline-data', corpusSha256: (mode === 'candidate' ? 'c' : 'b').repeat(64), generatedAt };
  const manifest = {
    schemaVersion: 'manifest-v1', generatedAt, totalEntries: ids.length, catalogueShards: { all: ids.length },
    artifacts: Object.entries(artifacts).map(([name, bytes]) => ({ path: name, byteSize: bytes.length, sha256: sha256(bytes) })), metadata,
  };
  writeJson(artifactPath(root, 'manifest.json'), manifest);
  writeFileSync(path.join(data, 'analytics.json'), stableJson({ mode, owner: 'complete-tree' }));
  return {
    releaseId: `${metadata.corpusId}@${generatedAt}`, corpusId: metadata.corpusId, generatedAt,
    corpusSha256: metadata.corpusSha256, manifestSha256: sha256(readFileSync(artifactPath(root, 'manifest.json'))), searchable: ids.length,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, sha256(bytes)])),
  };
}

function workspace(fixture = makeFixture(fakeRelease('baseline', '2026-10-29T00:00:00.000Z'), makeCases())) {
  const root = mkdtempSync(path.join(tempRoot, 'candidate-'));
  const baseline = mkdtempSync(path.join(tempRoot, 'baseline-'));
  const receiptRoot = mkdtempSync(path.join(tempRoot, 'receipts-'));
  for (const target of [root, baseline]) mkdirSync(path.dirname(fixturePath(target)), { recursive: true });
  writeData(baseline, 'baseline', fixture.cases);
  writeData(root, 'candidate', fixture.cases);
  const fixed = structuredClone(fixture);
  for (const testCase of fixed.cases) for (const judgment of testCase.expected) judgment.releaseId = fixed.release.releaseId;
  const bytes = Buffer.from(stableJson(fixed));
  writeFileSync(fixturePath(baseline), bytes);
  writeFileSync(fixturePath(root), bytes);
  return { root, baseline, receiptRoot, receiptPath: path.join(receiptRoot, 'binding-receipt.json'), baseBytes: bytes, baseFixture: fixed };
}

function bind(work, overrides = {}) {
  return bindSearchRelease({
    candidateRoot: work.root, baselineCandidateRoot: work.baseline, receiptPath: work.receiptPath, receiptRoot: work.receiptRoot,
    expectedFixtureSha256: sha256(work.baseBytes), expectedCohortSha256: cohortSha256(work.baseFixture),
    expectedBaselineDataIdentity: dataIdentity(work.baseline), transaction, ...overrides,
  });
}

function verify(work, overrides = {}) {
  return verifySearchReleaseReceipt({
    candidateRoot: work.root, baselineCandidateRoot: work.baseline, receiptPath: work.receiptPath, receiptRoot: work.receiptRoot,
    transaction, ...overrides,
  });
}

function rollback(work, overrides = {}) {
  return rollbackSearchReleaseBinding({
    candidateRoot: work.root, baselineCandidateRoot: work.baseline, receiptPath: work.receiptPath, receiptRoot: work.receiptRoot,
    transaction, ...overrides,
  });
}

function updateArtifact(work, name, value) {
  const bytes = Buffer.from(stableJson(value));
  writeFileSync(artifactPath(work.root, name), bytes);
  const manifest = JSON.parse(readFileSync(artifactPath(work.root, 'manifest.json'), 'utf8'));
  const row = manifest.artifacts.find((item) => item.path === name);
  row.byteSize = bytes.length;
  row.sha256 = sha256(bytes);
  writeJson(artifactPath(work.root, 'manifest.json'), manifest);
}

function updateArtifactText(work, name, text) {
  const bytes = Buffer.from(text);
  writeFileSync(artifactPath(work.root, name), bytes);
  const manifest = JSON.parse(readFileSync(artifactPath(work.root, 'manifest.json'), 'utf8'));
  const row = manifest.artifacts.find((item) => item.path === name);
  row.byteSize = bytes.length;
  row.sha256 = sha256(bytes);
  writeJson(artifactPath(work.root, 'manifest.json'), manifest);
}

function paddedIndexAtLimit(work, name) {
  const serialized = readFileSync(artifactPath(work.root, name), 'utf8').trimEnd();
  return `${serialized}${' '.repeat(MAX_SEARCH_ARTIFACT_CHARS - serialized.length)}`;
}

const readArtifact = (work, name) => JSON.parse(readFileSync(artifactPath(work.root, name), 'utf8'));
let tempRoot;
beforeEach(() => { tempRoot = mkdtempSync(path.join(os.tmpdir(), 'search-binding-')); });
afterEach(() => { rmSync(tempRoot, { recursive: true, force: true }); });

describe('B1 evaluator-exact normalization', () => {
  it('uppercases grade and normalizes the other supported filters', () => {
    expect(normalizeFilterKey('grade', 'low')).toBe('grade:LOW');
    expect(normalizeFilterKey('integration', ' Google  Sheets ')).toBe('integration:google-sheets');
  });

  it('binds the copied authentic 24-case fixture and selects grade:LOW', () => {
    const work = workspace(authentic);
    expect(deriveSearchRelease({ candidateRoot: work.root }).facetKeys).toContain('grade:LOW');
    const receipt = bind(work);
    expect(receipt.fieldDiff.length).toBeGreaterThan(0);
    expect(verify(work).release.releaseId).not.toBe(work.baseFixture.release.releaseId);

    const missing = workspace(authentic);
    const facets = readArtifact(missing, 'facets.json');
    delete facets.bitsets['grade:LOW'];
    updateArtifact(missing, 'facets.json', facets);
    expect(() => bind(missing)).toThrow(/grade:LOW/u);
  });
});

describe('B2 independent baseline identities and receipt v2', () => {
  it('binds stale baseline fixture bytes separately from the full baseline data tree', () => {
    const work = workspace();
    const receipt = bind(work);
    expect(receipt.schemaVersion).toBe(BINDING_RECEIPT_SCHEMA);
    expect(receipt.baseline.fixtureSha256).toBe(sha256(work.baseBytes));
    expect(receipt.baseline).not.toHaveProperty('release');
    expect(receipt.baseline.dataIdentity).toEqual(dataIdentity(work.baseline));
    expect(receipt.generated.dataIdentity).toEqual(dataIdentity(work.root));
    const baselineManifest = JSON.parse(readFileSync(artifactPath(work.baseline, 'manifest.json'), 'utf8'));
    expect(work.baseFixture.release.releaseId).not.toBe(`${baselineManifest.metadata.corpusId}@${baselineManifest.metadata.generatedAt}`);
    expect(receipt.helper).toHaveLength(5);
    expect(receipt.helper.map((item) => item.path)).toEqual(HELPER_PATHS);
    expect(receipt.fieldDiff.every((item) =>
      /^\/release\/(?:releaseId|corpusId|generatedAt|corpusSha256|manifestSha256|searchable)$/u.test(item.pointer) ||
      /^\/release\/artifacts\/[^/]+$/u.test(item.pointer) || /^\/cases\/\d+\/expected\/\d+\/releaseId$/u.test(item.pointer))).toBe(true);
    expect(verify(work).receipt).toEqual(receipt);
    expect(() => verify(work, { transaction: { ...transaction, attempt: 2 } })).toThrow(/transaction attempt/u);
  });

  it('rejects baseline or generated full-tree drift and helper-source drift', () => {
    for (const target of ['baseline', 'generated']) for (const operation of ['add', 'modify', 'remove']) {
      const work = workspace();
      bind(work);
      const file = path.join(target === 'baseline' ? work.baseline : work.root, 'data', 'analytics.json');
      if (operation === 'add') writeFileSync(path.join(path.dirname(file), 'foreign.txt'), 'foreign');
      if (operation === 'modify') writeFileSync(file, 'foreign');
      if (operation === 'remove') unlinkSync(file);
      expect(() => verify(work)).toThrow(/identity|tree|artifact|manifest/u);
    }
    const work = workspace();
    bind(work);
    const receipt = JSON.parse(readFileSync(work.receiptPath, 'utf8'));
    receipt.helper[1].sha256 = 'f'.repeat(64);
    writeJson(work.receiptPath, receipt);
    expect(() => verify(work)).toThrow(/helper/u);
  });

  it('rejects a v1 receipt and unknown ranking-quality fields', () => {
    for (const mutate of [
      (receipt) => { receipt.schemaVersion = 'search-release-binding-receipt-v1'; },
      (receipt) => { receipt.rankingQuality = 'passed'; },
      (receipt) => { receipt.helper.pop(); },
    ]) {
      const work = workspace();
      bind(work);
      const receipt = JSON.parse(readFileSync(work.receiptPath, 'utf8'));
      mutate(receipt);
      writeJson(work.receiptPath, receipt);
      expect(() => verify(work)).toThrow(/receipt|keys|schema/u);
    }
  });
});

describe('B3 complete data tree ownership', () => {
  it('rejects add, remove, modify, symlink, junction, and hard-link drift', () => {
    for (const mutation of ['add', 'remove', 'modify']) {
      const work = workspace();
      bind(work);
      const file = path.join(work.root, 'data', 'analytics.json');
      if (mutation === 'add') writeFileSync(path.join(work.root, 'data', 'foreign.txt'), 'foreign');
      if (mutation === 'remove') unlinkSync(file);
      if (mutation === 'modify') writeFileSync(file, 'foreign');
      expect(() => verify(work)).toThrow(/identity|tree/u);
    }
    const linkedFile = workspace();
    bind(linkedFile);
    const outside = path.join(linkedFile.root, 'outside.json');
    writeFileSync(outside, 'outside');
    linkSync(outside, path.join(linkedFile.root, 'data', 'hard-link.json'));
    expect(() => verify(linkedFile)).toThrow(/hard-linked/u);

    const nestedLink = workspace();
    bind(nestedLink);
    const target = mkdtempSync(path.join(tempRoot, 'link-target-'));
    writeFileSync(path.join(target, 'foreign.txt'), 'foreign');
    symlinkSync(target, path.join(nestedLink.root, 'data', 'nested-link'), 'junction');
    expect(() => verify(nestedLink)).toThrow(/symlink|junction/u);
  });

  it('rejects fixture hard links and aliased roots', () => {
    const fixtureLink = workspace();
    linkSync(fixturePath(fixtureLink.root), path.join(fixtureLink.root, 'fixture-alias.json'));
    expect(() => bind(fixtureLink)).toThrow(/hard-linked/u);

    const rootLink = workspace();
    const parent = mkdtempSync(path.join(tempRoot, 'alias-parent-'));
    const rootAlias = path.join(parent, 'candidate-alias');
    symlinkSync(rootLink.root, rootAlias, 'junction');
    expect(() => resolveSearchReleasePaths({
      candidateRoot: rootAlias, baselineCandidateRoot: rootLink.baseline, receiptPath: rootLink.receiptPath, receiptRoot: rootLink.receiptRoot,
    })).toThrow(/symlink|junction/u);

    const same = workspace();
    expect(() => resolveSearchReleasePaths({
      candidateRoot: same.root, baselineCandidateRoot: path.join(same.root, '..', path.basename(same.root)),
      receiptPath: same.receiptPath, receiptRoot: same.receiptRoot,
    })).toThrow(/distinct/u);
    if (process.platform === 'win32') expect(() => resolveSearchReleasePaths({
      candidateRoot: same.root, baselineCandidateRoot: same.root.toUpperCase(), receiptPath: same.receiptPath, receiptRoot: same.receiptRoot,
    })).toThrow(/distinct/u);
  });
});

describe('B4 durable rollback and recovery', () => {
  const renameFaults = [
    ['move-data', 'before'], ['move-data', 'after'], ['install-data', 'before'], ['install-data', 'after'],
    ['move-fixture', 'before'], ['move-fixture', 'after'], ['install-fixture', 'before'], ['install-fixture', 'after'],
  ];

  it('restores the independent baseline pair and leaves a completed journal', () => {
    const work = workspace();
    const receipt = bind(work);
    const result = rollback(work);
    expect(result.status).toBe('rolled-back');
    expect(readFileSync(fixturePath(work.root))).toEqual(work.baseBytes);
    expect(dataIdentity(work.root)).toEqual(receipt.baseline.dataIdentity);
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'));
    expect(journal.receiptSha256).toMatch(HASH);
    expect(journal.status).toBe('rolled-back');
    expect(journal.recoveryPath).toMatch(/search-release-recovery/u);
  });

  it.each(renameFaults)('compensates a %s %s failure and preserves the candidate pair', (phase, point) => {
    const work = workspace();
    bind(work);
    const beforeFixture = readFileSync(fixturePath(work.root));
    const beforeData = dataIdentity(work.root);
    let fired = false;
    expect(() => rollback(work, { faultInjector(operation, timing) {
      if (!fired && operation === phase && timing === point) { fired = true; throw new Error(`injected ${operation} ${timing}`); }
    } })).toThrow(/injected/u);
    const journal = JSON.parse(readFileSync(path.join(work.receiptRoot, `search-release-rollback-${transaction.id}.json`), 'utf8'));
    expect(journal.status).toBe('compensated');
    expect(readFileSync(fixturePath(work.root))).toEqual(beforeFixture);
    expect(dataIdentity(work.root)).toEqual(beforeData);
    expect(verify(work).receipt.transaction).toEqual(transaction);
  });

  it('compensates after post-restore verification fails', () => {
    const work = workspace();
    bind(work);
    const before = dataIdentity(work.root);
    let fired = false;
    expect(() => rollback(work, { faultInjector(operation, timing) {
      if (!fired && operation === 'verify-restored' && timing === 'after') { fired = true; throw new Error('injected verification failure'); }
    } })).toThrow(/verification failure/u);
    expect(dataIdentity(work.root)).toEqual(before);
    const journal = JSON.parse(readFileSync(path.join(work.receiptRoot, `search-release-rollback-${transaction.id}.json`), 'utf8'));
    expect(journal.status).toBe('compensated');
  });

  it('preserves owned originals when compensation fails', () => {
    const work = workspace();
    bind(work);
    const originalFixture = readFileSync(fixturePath(work.root));
    const originalData = dataIdentity(work.root);
    expect(() => rollback(work, { faultInjector(operation, timing) {
      if (operation === 'install-fixture' && timing === 'after') throw new Error('install failed');
      if (operation === 'compensate-fixture' && timing === 'before') throw new Error('compensation failed');
    } })).toThrow(/RECOVERY_REQUIRED.*journal.*recovery/u);
    const journal = JSON.parse(readFileSync(path.join(work.receiptRoot, `search-release-rollback-${transaction.id}.json`), 'utf8'));
    expect(journal.status).toBe('recovery-required');
    expect(dataIdentity(path.join(journal.recoveryPath, 'owned'))).toEqual(originalData);
    expect(readFileSync(path.join(journal.recoveryPath, 'owned', 'fixture'))).toEqual(originalFixture);
  });

  it('refuses to overwrite a foreign target and retains a recoverable copy', () => {
    const work = workspace();
    bind(work);
    const foreign = Buffer.from('foreign candidate data\n');
    expect(() => rollback(work, { faultInjector(operation, timing) {
      if (operation === 'move-data' && timing === 'after') {
        mkdirSync(path.join(work.root, 'data'));
        writeFileSync(path.join(work.root, 'data', 'foreign.txt'), foreign);
        throw new Error('target replaced');
      }
      if (operation === 'compensate-data' && timing === 'before') throw new Error('compensation blocked by foreign target');
    } })).toThrow(/RECOVERY_REQUIRED/u);
    const journal = JSON.parse(readFileSync(path.join(work.receiptRoot, `search-release-rollback-${transaction.id}.json`), 'utf8'));
    expect(journal.status).toBe('recovery-required');
    expect(readFileSync(path.join(work.root, 'data', 'foreign.txt'))).toEqual(foreign);
    expect(existsSync(path.join(journal.recoveryPath, 'owned', 'data', 'analytics.json'))).toBe(true);
  });
});

describe('B5 worker-equivalent hydrated ordinals and bitsets', () => {
  it('uses complete MiniSearch artifacts accepted by the canonical parser and worker hydration', () => {
    const work = workspace();
    for (const name of ['search-index.json', 'search-index-extended.json']) {
      const raw = readArtifact(work, name);
      expect(() => parseSearchIndexArtifact(raw)).not.toThrow();
      const hydrated = MiniSearch.loadJSON(stableJson(raw), {
        fields: [...SEARCH_FIELDS], storeFields: [...SEARCH_STORE_FIELDS],
      });
      for (const documentId of Object.values(raw.documentIds)) {
        expect(hydrated.getStoredFields(documentId)).toMatchObject({ id: documentId });
      }
    }
    const derived = deriveSearchRelease({ candidateRoot: work.root });
    expect(derived.facetKeys).toContain('grade:LOW');
    expect(derived.facetKeys).toContain('rights:link_only');
    expect(derived.facetKeys).not.toContain('rights:link-only');
    expect(bind(work).helper.map((item) => item.path)).toEqual(HELPER_PATHS);
  });

  it('requires the canonical parser and binder to reject incomplete worker structures', () => {
    const mutations = [
      (index) => { delete index.serializationVersion; },
      (index) => { index.nextId = index.documentCount - 1; },
      (index) => { delete index.fieldIds.content; },
      (index) => { index.averageFieldLength.pop(); },
      (index) => { delete index.fieldLength[0]; },
      (index) => { delete index.storedFields[0].summary; },
      (index) => { index.dirtCount = index.nextId + 1; },
      (index) => {
        const [, fields] = index.index.find(([, candidate]) => Object.keys(candidate).length > 0);
        const postings = Object.values(fields).find((candidate) => Object.keys(candidate).length > 0);
        postings[Object.keys(postings)[0]] = 0;
      },
    ];
    for (const mutate of mutations) {
      const work = workspace();
      const index = readArtifact(work, 'search-index.json');
      mutate(index);
      expect(() => parseSearchIndexArtifact(index)).toThrow(/Malformed search index/u);
      expect(() => validateSearchIndexArtifact(index, 'primary index')).toThrow(/Malformed primary index/u);
      updateArtifact(work, 'search-index.json', index);
      expect(() => deriveSearchRelease({ candidateRoot: work.root })).toThrow(/Malformed primary index/u);
    }
  });

  it.each([
    ['search-index.json', 'primary index'],
    ['search-index-extended.json', 'extended index'],
  ])('rejects an oversized valid %s before fixture or receipt writes', (name, label) => {
    const work = workspace();
    const serialized = readFileSync(artifactPath(work.root, name), 'utf8').trimEnd();
    const oversized = `${serialized}${' '.repeat(MAX_SEARCH_ARTIFACT_CHARS + 1 - serialized.length)}`;
    expect(oversized).toHaveLength(MAX_SEARCH_ARTIFACT_CHARS + 1);
    expect(() => parseSearchIndexJson(oversized)).toThrow(/payload is too large/u);
    updateArtifactText(work, name, oversized);
    const fixtureBefore = readFileSync(fixturePath(work.root));
    let writerCalls = 0;
    expect(() => bind(work, { atomicWriter() { writerCalls += 1; } })).toThrow(new RegExp(`${label}.*payload is too large`, 'iu'));
    expect(writerCalls).toBe(0);
    expect(readFileSync(fixturePath(work.root))).toEqual(fixtureBefore);
    expect(existsSync(work.receiptPath)).toBe(false);
  }, 60_000);

  it('accepts both indexes exactly at the canonical JSON character boundary', () => {
    const work = workspace();
    for (const name of ['search-index.json', 'search-index-extended.json']) updateArtifactText(work, name, paddedIndexAtLimit(work, name));
    for (const name of ['search-index.json', 'search-index-extended.json']) {
      const text = readFileSync(artifactPath(work.root, name), 'utf8');
      expect(text).toHaveLength(MAX_SEARCH_ARTIFACT_CHARS);
      expect(() => parseSearchIndexJson(text)).not.toThrow();
    }
    expect(() => deriveSearchRelease({ candidateRoot: work.root })).not.toThrow();
    expect(bind(work).generated.release.searchable).toBe(3);
  }, 60_000);

  it('detects an extended append that makes facets ordinals/total incompatible', () => {
    const work = workspace();
    const ids = Object.values(readArtifact(work, 'search-index.json').documentIds);
    updateArtifact(work, 'search-index.json', indexArtifact(ids.slice(0, 2), 'primary'));
    updateArtifact(work, 'search-index-extended.json', indexArtifact([ids[2]], 'extended'));
    const facets = readArtifact(work, 'facets.json');
    facets.ordinals = ids.slice(0, 2);
    facets.total = 3;
    facets.bitsets = Object.fromEntries(Object.entries(facets.bitsets).map(([key]) => [key, encodeBitset(3, [1])]));
    updateArtifact(work, 'facets.json', facets);
    expect(() => deriveSearchRelease({ candidateRoot: work.root })).toThrow(/ordinals\/total|incompatible/u);
  });

  it('rejects facet-only, unhydrated, orphan, and ambiguous IDs', () => {
    const facetOnly = workspace();
    const facets = readArtifact(facetOnly, 'facets.json');
    facets.ordinals.push('facet-only');
    facets.total += 1;
    facets.bitsets = Object.fromEntries(Object.entries(facets.bitsets).map(([key]) => [key, encodeBitset(facets.total, [0])]));
    updateArtifact(facetOnly, 'facets.json', facets);
    expect(() => deriveSearchRelease({ candidateRoot: facetOnly.root })).toThrow(/hydrat|unhydrated/u);

    const orphan = workspace();
    const orphanIds = Object.values(readArtifact(orphan, 'search-index.json').documentIds);
    updateArtifact(orphan, 'search-index.json', indexArtifact([...orphanIds, 'primary-orphan'], 'orphan'));
    expect(() => deriveSearchRelease({ candidateRoot: orphan.root })).toThrow(/orphan|ordinal/u);

    const ambiguous = workspace();
    const [first] = Object.values(readArtifact(ambiguous, 'search-index.json').documentIds);
    updateArtifact(ambiguous, 'search-index-extended.json', indexArtifact([first], 'duplicate'));
    expect(() => deriveSearchRelease({ candidateRoot: ambiguous.root })).toThrow(/ambiguous|duplicate/u);
  });

  it('rejects noncanonical base64, wrong lengths, padding bits, and incompatible counts', () => {
    const cases = [
      [(facets) => { facets.bitsets['grade:LOW'] = '***'; }, /base64|bitset/u],
      [(facets) => { facets.bitsets['grade:LOW'] = 'AQ=='; }, /bitset|length|size/u],
      [(facets) => { const bytes = Buffer.alloc(4); bytes[3] = 0x80; facets.bitsets['grade:LOW'] = bytes.toString('base64'); }, /padding|outside/u],
      [(facets) => { facets.total += 1; }, /total|ordinal|count/u],
    ];
    for (const [mutate, message] of cases) {
      const work = workspace();
      const facets = readArtifact(work, 'facets.json');
      mutate(facets);
      updateArtifact(work, 'facets.json', facets);
      expect(() => deriveSearchRelease({ candidateRoot: work.root })).toThrow(message);
    }
  });

  it('enforces OR within a dimension and intersection across dimensions', () => {
    const orPresent = workspace();
    const orFacets = readArtifact(orPresent, 'facets.json');
    orFacets.bitsets['integration:google-sheets'] = encodeBitset(orFacets.total, []);
    updateArtifact(orPresent, 'facets.json', orFacets);
    expect(() => bind(orPresent)).not.toThrow();

    const missingDimension = workspace();
    const missingFacets = readArtifact(missingDimension, 'facets.json');
    missingFacets.bitsets['grade:LOW'] = encodeBitset(missingFacets.total, []);
    updateArtifact(missingDimension, 'facets.json', missingFacets);
    expect(() => bind(missingDimension)).toThrow(/grade:LOW|eligible|judged/u);
  });
});

describe('B6 safe path boundaries and receipt publication', () => {
  if (process.platform === 'win32') it('rejects Windows-unsafe transaction components before writing paths', () => {
    const unsafe = [
      'run:2026-10-31', 'run/2026-10-31', 'run\\2026-10-31', '.', '..', '.hidden',
      'run.', 'run\u0001', 'CON', 'con.txt', 'LPT9.log', 'a'.repeat(97),
    ];
    for (const id of unsafe) {
      const work = workspace();
      bind(work);
      expect(() => rollback(work, { transaction: { ...transaction, id } })).toThrow(/transaction\.id/u);
      expect(readdirSync(work.receiptRoot).some((name) => name.startsWith('search-release-rollback-'))).toBe(false);
      expect(readdirSync(work.root).some((name) => name.startsWith('.search-release-recovery-'))).toBe(false);
    }
  });

  it('requires an explicit receipt root outside data and fixtures', () => {
    const work = workspace();
    expect(() => resolveSearchReleasePaths({ candidateRoot: work.root, baselineCandidateRoot: work.baseline, receiptPath: work.receiptPath })).toThrow(/receiptRoot/u);
    for (const receiptPath of [
      path.join(work.root, 'data', 'receipt.json'),
      path.join(work.root, APPROVED_FIXTURE_PATH, 'receipt.json'),
      path.join(work.baseline, APPROVED_FIXTURE_PATH, 'receipt.json'),
    ]) expect(() => resolveSearchReleasePaths({
      candidateRoot: work.root, baselineCandidateRoot: work.baseline, receiptPath, receiptRoot: work.receiptRoot,
    })).toThrow(/receipt|fixture|data/u);
  });

  it('publishes exclusively and restores only its owned fixture on publication failure', () => {
    const work = workspace();
    const before = readFileSync(fixturePath(work.root));
    expect(() => bind(work, { atomicWriter(target, bytes) {
      if (target === work.receiptPath) throw new Error('injected receipt failure');
      writeFileSync(target, bytes);
    } })).toThrow(/receipt failure/u);
    expect(readFileSync(fixturePath(work.root))).toEqual(before);
    expect(existsSync(work.receiptPath)).toBe(false);

    mkdirSync(path.dirname(work.receiptPath), { recursive: true });
    const foreign = Buffer.from('foreign receipt\n');
    writeFileSync(work.receiptPath, foreign);
    expect(() => bind(work)).toThrow(/receipt already exists/u);
    expect(readFileSync(work.receiptPath)).toEqual(foreign);
    expect(readFileSync(fixturePath(work.root))).toEqual(before);
  });

  it('keeps cohort/query hashes and exact release-only field pointers', () => {
    const work = workspace();
    const receipt = bind(work);
    expect(cohortSha256(JSON.parse(readFileSync(fixturePath(work.root), 'utf8')))).toBe(receipt.generated.cohortSha256);
    const generated = JSON.parse(readFileSync(fixturePath(work.root), 'utf8'));
    generated.cases[0].query += ' changed';
    expect(() => semanticFieldDiff(work.baseFixture, generated)).toThrow(/query-set|cohort|allowlist/u);
  });
});
