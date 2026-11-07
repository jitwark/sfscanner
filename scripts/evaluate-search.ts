import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SearchEngine } from '../app/src/search/worker';
import { handleWorkerSearchMessage } from '../app/src/search/worker-message-handler';
import { parseSemanticIndexJson } from '../contracts/semantic-index-artifact';

type Filter = string | string[]; type Expected = { id: string; relevance: 1 | 2 | 3; rationale: string; reviewer: string; reviewedOn: string; releaseId: string };
type Protocol = { tuningSplit: 'development'; holdoutSplit: 'holdout'; holdoutPolicy: 'untouched-evaluate-once'; queryKey: 'query+filters+sort-v1'; developmentQuerySetSha256: string; holdoutQuerySetSha256: string };
type RelevanceCase = {
  id: string; split: 'development' | 'holdout'; kind: string; sort: 'relevance' | 'quality'; query: string;
  filters?: Record<string, Filter>; strata: string[]; expected: Expected[];
  adjudication?: { status: string; reviewers: string[]; decision: string };
};
type Fixture = {
  schemaVersion: string; createdOn: string; reviewers: string[];
  release: { releaseId: string; corpusId: string; generatedAt: string; corpusSha256: string; manifestSha256: string; searchable: number; artifacts: Record<string, string> };
  protocol: Protocol; cases: RelevanceCase[];
};
const root = resolve(import.meta.dirname, '..');
const sourceDir = resolve(root, 'data');
const dataDir = resolve(root, 'app', 'public', 'data');
const requiredArtifacts = ['search-index.json', 'search-index-extended.json', 'facets.json', 'semantic-index.json'];
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const caseKey = (testCase: RelevanceCase) => JSON.stringify([testCase.query, Object.fromEntries(Object.entries(testCase.filters ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])), testCase.sort]);
const splitQuerySetHash = (cases: RelevanceCase[], split: RelevanceCase['split']) => hash(cases.filter((testCase) => testCase.split === split).map(caseKey).sort().join('\n'));
function releaseId(metadata: Record<string, any>): string {
  return `${metadata.corpusId}@${metadata.generatedAt}`;
}

function normalizeFacetValue(filter: string, value: string): string {
  if (filter === 'grade') return value.toUpperCase();
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
function validateFixture(fixture: Fixture, manifest: Record<string, any>, facets: Record<string, any>, ids: Set<string>): string[] {
  const errors: string[] = [];
  const metadata = manifest.metadata ?? {};
  const expectedRelease = releaseId(metadata);
  if (fixture.schemaVersion !== 'relevance-set-v2') errors.push(`unsupported fixture schema: ${fixture.schemaVersion}`);
  if (fixture.release.releaseId !== expectedRelease) errors.push(`fixture release ${fixture.release.releaseId} does not match ${expectedRelease}`);
  for (const field of ['corpusId', 'generatedAt', 'corpusSha256']) {
    const expected = field === 'corpusId' ? metadata.corpusId : field === 'generatedAt' ? metadata.generatedAt : metadata.corpusSha256;
    if (fixture.release[field as keyof typeof fixture.release] !== expected) errors.push(`release.${field} is stale`);
  }
  const manifestBytes = readFileSync(resolve(sourceDir, 'manifest.json'));
  if (fixture.release.manifestSha256 !== hash(manifestBytes)) errors.push('release.manifestSha256 is stale');
  if (fixture.release.searchable !== facets.total) errors.push(`release.searchable ${fixture.release.searchable} does not match facets.total ${facets.total}`);
  for (const artifact of requiredArtifacts) {
    const actual = hash(readFileSync(resolve(dataDir, artifact)));
    if (fixture.release.artifacts[artifact] !== actual) errors.push(`release artifact hash is stale: ${artifact}`);
    if (actual !== hash(readFileSync(resolve(sourceDir, artifact)))) errors.push(`source and browser artifact differ: ${artifact}`);
  }
  try {
    if (parseSemanticIndexJson(readFileSync(resolve(dataDir, 'semantic-index.json'), 'utf8')).documents.length === 0) {
      errors.push('semantic artifact is unavailable: no vectors');
    }
  } catch { errors.push('semantic artifact is unavailable or malformed'); }
  const facetKeys = new Set(Object.keys(facets.bitsets ?? {}));
  const prefixes: Record<string, string> = { rights: 'rights', grade: 'grade', trigger: 'trigger', complexity: 'complexity', capability: 'capability', integration: 'integration', tag: 'tag' };
  const allowedKinds = new Set(['exact', 'navigational', 'facet', 'natural-language', 'alias', 'misspelling', 'zero-result', 'ambiguous']);
  const allowedStrata = new Set(['official', 'link-only', 'redistributable', 'common', 'rare', 'safe', 'risky']);
  const seenCases = new Set<string>();
  const querySplits = new Map<string, string>();
  for (const testCase of fixture.cases) {
    if (seenCases.has(testCase.id)) errors.push(`duplicate case id: ${testCase.id}`);
    seenCases.add(testCase.id);
    const query = caseKey(testCase); const previousSplit = querySplits.get(query);
    if (previousSplit && previousSplit !== testCase.split) errors.push(`${testCase.id}: holdout query contamination across ${previousSplit}/${testCase.split}`);
    querySplits.set(query, testCase.split);
    if (!allowedKinds.has(testCase.kind)) errors.push(`${testCase.id}: unsupported kind ${testCase.kind}`);
    if (!['relevance', 'quality'].includes(testCase.sort)) errors.push(`${testCase.id}: unsupported sort ${testCase.sort}`);
    if (testCase.strata.length === 0 || testCase.strata.some((stratum) => !allowedStrata.has(stratum))) errors.push(`${testCase.id}: invalid corpus stratum`);
    if (testCase.expected.length === 0 && testCase.kind !== 'zero-result') errors.push(`${testCase.id}: non-zero case has no judgments`);
    if (testCase.kind === 'zero-result' && testCase.expected.length > 0) errors.push(`${testCase.id}: zero-result case has judgments`);
    const expectedIds = new Set<string>();
    for (const judgment of testCase.expected) {
      if (expectedIds.has(judgment.id)) errors.push(`${testCase.id}: duplicate expected ID ${judgment.id}`);
      expectedIds.add(judgment.id);
      if (!ids.has(judgment.id)) errors.push(`${testCase.id}: expected ID missing from release: ${judgment.id}`);
      if (judgment.releaseId !== fixture.release.releaseId) errors.push(`${testCase.id}: judgment release mismatch for ${judgment.id}`);
      if (!judgment.reviewer || !judgment.reviewedOn || !judgment.rationale) errors.push(`${testCase.id}: incomplete judgment for ${judgment.id}`);
    }
    for (const [filter, raw] of Object.entries(testCase.filters ?? {})) {
      if (!prefixes[filter]) { errors.push(`${testCase.id}: unsupported filter ${filter}`); continue; }
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        const key = `${prefixes[filter]}:${normalizeFacetValue(filter, value)}`;
        if (!facetKeys.has(key)) errors.push(`${testCase.id}: facet is not in release: ${filter}=${value}`);
      }
    }
    if (testCase.kind === 'ambiguous' && testCase.adjudication?.status !== 'adjudicated') errors.push(`${testCase.id}: ambiguous case lacks adjudication`);
    if (testCase.kind === 'ambiguous' && (testCase.adjudication?.reviewers.length ?? 0) < 2) errors.push(`${testCase.id}: ambiguous case needs two reviewers`);
  }
  const kinds = new Set(fixture.cases.map((testCase) => testCase.kind));
  const strata = new Set(fixture.cases.flatMap((testCase) => testCase.strata));
  for (const kind of allowedKinds) if (!kinds.has(kind)) errors.push(`fixture lacks query kind: ${kind}`);
  for (const stratum of allowedStrata) if (!strata.has(stratum)) errors.push(`fixture lacks corpus stratum: ${stratum}`);
  if (!fixture.cases.some((testCase) => testCase.split === 'development')) errors.push('fixture lacks development split');
  if (!fixture.cases.some((testCase) => testCase.split === 'holdout')) errors.push('fixture lacks holdout split');
  const protocol = fixture.protocol;
  if (protocol?.tuningSplit !== 'development' || protocol?.holdoutSplit !== 'holdout' || protocol?.holdoutPolicy !== 'untouched-evaluate-once' || protocol?.queryKey !== 'query+filters+sort-v1') errors.push('fixture holdout protocol is missing or invalid');
  if (protocol?.developmentQuerySetSha256 !== splitQuerySetHash(fixture.cases, 'development') || protocol?.holdoutQuerySetSha256 !== splitQuerySetHash(fixture.cases, 'holdout')) errors.push('fixture holdout protocol query hashes are stale');
  return errors;
}
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
}
function ndcg(actual: string[], expected: Expected[]): number {
  const grades = new Map(expected.map((item) => [item.id, item.relevance]));
  const dcg = actual.slice(0, 10).reduce((sum, id, index) => sum + ((2 ** (grades.get(id) ?? 0)) - 1) / Math.log2(index + 2), 0);
  const ideal = expected.map((item) => item.relevance).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}
function artifactMetrics(): Record<string, Record<string, number | string>> {
  return Object.fromEntries(requiredArtifacts.map((name) => {
    const bytes = readFileSync(resolve(dataDir, name));
    return [name, { raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength, brotli: brotliCompressSync(bytes).byteLength, sha256: hash(bytes) }];
  }));
}
function main() {
  const manifest = readJson(resolve(sourceDir, 'manifest.json'));
  const fixture = readJson(resolve(root, 'app/src/search/__fixtures__/relevance-set.json')) as unknown as Fixture;
  const primary = readJson(resolve(dataDir, 'search-index.json'));
  const extended = readJson(resolve(dataDir, 'search-index-extended.json'));
  const facets = readJson(resolve(dataDir, 'facets.json'));
  const ids = new Set<string>([
    ...Object.values(primary.storedFields ?? {}).map((item: any) => item.id),
    ...Object.values(extended.storedFields ?? {}).map((item: any) => item.id),
    ...(facets.ordinals ?? []),
  ]);
  const validationErrors = validateFixture(fixture, manifest, facets, ids);
  if (validationErrors.length > 0) {
    console.error(JSON.stringify({ validationErrors }, null, 2));
    process.exit(1);
  }
  const artifacts = Object.fromEntries(requiredArtifacts.map((name) => [name, readFileSync(resolve(dataDir, name), 'utf8')]));
  const started = performance.now();
  const engine = new SearchEngine();
  // `readJson` widens to `Record<string, any>`; the packaged artifact's shape is
  // what the corpus gate already validates.
  engine.init(artifacts['search-index.json']!, facets as unknown as Parameters<typeof engine.init>[1], artifacts['semantic-index.json']!);
  engine.loadExtendedIndex(artifacts['search-index-extended.json']!);
  const initMs = performance.now() - started;
  const queryTimes: number[] = [];
  let recall = 0; let mrr = 0; let ndcgTotal = 0; let positive = 0; let recalled = 0; let zeroCorrect = 0;
  const failures: Array<{ id: string; query: string; expected: string[]; actual: string[] }> = [];
  const byKind: Record<string, { cases: number; recallAt10: number; mrr: number; ndcgAt10: number }> = {};
  const bySplit: Record<string, { cases: number; recallAt10: number; mrr: number; ndcgAt10: number }> = {};
  const byStratum: Record<string, number[]> = {};
  fixture.cases.forEach((testCase, index) => {
    const startedQuery = performance.now();
    const response = handleWorkerSearchMessage(engine, {
      type: 'search', id: index + 1, query: testCase.query, filters: testCase.filters,
      options: { limit: 10, sort: testCase.sort },
    });
    queryTimes.push(performance.now() - startedQuery);
    for (const stratum of testCase.strata) (byStratum[stratum] ??= []).push(queryTimes.at(-1)!);
    const actual = response?.ids.slice(0, 10) ?? [];
    const expected = testCase.expected;
    const expectedIds = new Set(expected.map((item) => item.id));
    const hits = expected.filter((item) => actual.includes(item.id)).length;
    const rank = actual.findIndex((id) => expectedIds.has(id));
    const caseRecall = expected.length ? hits / expected.length : actual.length === 0 ? 1 : 0;
    const caseMrr = rank >= 0 ? 1 / (rank + 1) : 0;
    const caseNdcg = ndcg(actual, expected);
    recall += caseRecall; mrr += caseMrr; ndcgTotal += caseNdcg;
    if (expected.length > 0) { positive += 1; if (hits > 0) recalled += 1; }
    else if (actual.length === 0) zeroCorrect += 1;
    if ((expected.length > 0 && hits === 0) || (expected.length === 0 && actual.length > 0)) failures.push({ id: testCase.id, query: testCase.query, expected: expected.map((item) => item.id), actual });
    const group = byKind[testCase.kind] ??= { cases: 0, recallAt10: 0, mrr: 0, ndcgAt10: 0 };
    group.cases += 1; group.recallAt10 += caseRecall; group.mrr += caseMrr; group.ndcgAt10 += caseNdcg;
    const splitGroup = bySplit[testCase.split] ??= { cases: 0, recallAt10: 0, mrr: 0, ndcgAt10: 0 };
    splitGroup.cases += 1; splitGroup.recallAt10 += caseRecall; splitGroup.mrr += caseMrr; splitGroup.ndcgAt10 += caseNdcg;
  });
  Object.values(byKind).forEach((group) => { group.recallAt10 /= group.cases; group.mrr /= group.cases; group.ndcgAt10 /= group.cases; });
  Object.values(bySplit).forEach((group) => { group.recallAt10 /= group.cases; group.mrr /= group.cases; group.ndcgAt10 /= group.cases; });
  const timingByStratum = Object.fromEntries(Object.entries(byStratum).map(([stratum, values]) => [stratum, { cases: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) }]));
  const release = manifest.metadata;
  const report = {
    schemaVersion: 'search-quality-report-v1', releaseId: releaseId(release), corpusSha256: release.corpusSha256,
    fixtureSchemaVersion: fixture.schemaVersion, cases: fixture.cases.length, positiveCases: positive,
    protocol: { ...fixture.protocol, developmentQuerySetSha256: splitQuerySetHash(fixture.cases, 'development'), holdoutQuerySetSha256: splitQuerySetHash(fixture.cases, 'holdout') },
    recallAt10: recall / fixture.cases.length, mrr: mrr / fixture.cases.length, ndcgAt10: ndcgTotal / fixture.cases.length,
    exactAndNavigationalSuccess: fixture.cases.filter((item) => ['exact', 'navigational'].includes(item.kind)).filter((item) => !failures.some((failure) => failure.id === item.id)).length,
    exactAndNavigationalCases: fixture.cases.filter((item) => ['exact', 'navigational'].includes(item.kind)).length,
    zeroResultAccuracy: fixture.cases.filter((item) => item.kind === 'zero-result').length ? zeroCorrect / fixture.cases.filter((item) => item.kind === 'zero-result').length : 1,
    queryHitRate: positive ? recalled / positive : 1, latencyMs: { coldInit: initMs, warm: { p50: percentile(queryTimes, 0.5), p95: percentile(queryTimes, 0.95), max: Math.max(...queryTimes) }, byStratum: timingByStratum },
    bytes: { initRaw: statSync(resolve(dataDir, 'search-index.json')).size + statSync(resolve(dataDir, 'facets.json')).size, queryRuntime: 0, artifacts: artifactMetrics() },
    memory: { rssBytes: process.memoryUsage().rss }, byKind, bySplit, failures,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report));
  else console.log(JSON.stringify(report, null, 2));
}
main();
