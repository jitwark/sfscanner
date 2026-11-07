import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseKey, protocolSplits, validateBenchmarkProtocol } from './lib/search-quality-protocol.mjs';
import { loadSearchQualityThresholds } from './lib/search-quality-thresholds.mjs';

export { loadSearchQualityThresholds } from './lib/search-quality-thresholds.mjs';
const root = resolve(import.meta.dirname, '..');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
export function validateSearchQualityGate({ report, fixture, env }) {
  const errors = [];
  if (!isRecord(report)) return ['search quality report is not an object'];
  if (!isRecord(fixture)) return ['relevance fixture is not an object'];
  const finite = (path, value, bounded = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} must be finite`);
    else if (bounded && (value < 0 || value > 1)) errors.push(`${path} must be between 0 and 1`);
  };
  const integer = (path, value, minimum = 0) => {
    if (!Number.isInteger(value) || value < minimum) errors.push(`${path} must be an integer >= ${minimum}`);
  };
  const metricGroup = (path, group) => {
    if (!isRecord(group)) { errors.push(`${path} is missing`); return; }
    finite(`${path}.recallAt10`, group.recallAt10, true);
    finite(`${path}.mrr`, group.mrr, true);
    finite(`${path}.ndcgAt10`, group.ndcgAt10, true);
  };
  if (fixture.schemaVersion !== 'relevance-set-v2') errors.push('fixture schema is not relevance-set-v2');
  if (!isDate(fixture.createdOn)) errors.push('fixture.createdOn is missing or invalid');
  if (!Array.isArray(fixture.reviewers) || fixture.reviewers.length < 2
    || fixture.reviewers.some((reviewer) => typeof reviewer !== 'string' || !reviewer.trim())
    || new Set(fixture.reviewers).size !== fixture.reviewers.length) errors.push('fixture reviewer governance is missing or invalid');

  const release = isRecord(fixture.release) ? fixture.release : {};
  for (const field of ['releaseId', 'corpusSha256']) {
    if (typeof release[field] !== 'string' || !release[field]) errors.push(`fixture.release.${field} is missing or invalid`);
    if (report[field] !== release[field]) errors.push(`report.${field} does not match the fixture`);
  }
  if (report.schemaVersion !== 'search-quality-report-v1') errors.push('report schema is not search-quality-report-v1');
  if (report.fixtureSchemaVersion !== fixture.schemaVersion) errors.push('report fixture schema does not match the fixture');

  const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
  if (!cases.length) errors.push('fixture has no judged cases');
  const splitCounts = Object.fromEntries(protocolSplits.map((split) => [split, 0]));
  const querySplits = new Map();
  for (const testCase of cases) {
    if (!isRecord(testCase) || typeof testCase.id !== 'string' || !testCase.id.trim()) errors.push('fixture contains a case without an ID');
    if (!isRecord(testCase) || !protocolSplits.includes(testCase.split)) errors.push(`${testCase?.id ?? 'case'} has an invalid protocol split`);
    else {
      splitCounts[testCase.split] += 1;
      const key = caseKey(testCase); const previousSplit = querySplits.get(key);
      if (previousSplit && previousSplit !== testCase.split) errors.push(`${testCase.id}: holdout query contamination across ${previousSplit}/${testCase.split}`);
      querySplits.set(key, testCase.split);
    }
  }
  for (const split of protocolSplits) if (!splitCounts[split]) errors.push(`fixture lacks ${split} split`);
  validateBenchmarkProtocol({ report, fixture, cases, errors });
  integer('report.cases', report.cases, 1);
  if (report.cases !== cases.length) errors.push(`report.cases ${report.cases} does not match fixture cases ${cases.length}`);
  const positiveCases = cases.filter((testCase) => Array.isArray(testCase?.expected) && testCase.expected.length > 0).length;
  integer('report.positiveCases', report.positiveCases);
  if (report.positiveCases !== positiveCases) errors.push('report.positiveCases does not match the fixture');
  for (const field of ['recallAt10', 'mrr', 'ndcgAt10', 'zeroResultAccuracy', 'queryHitRate']) finite(`report.${field}`, report[field], true);

  if (!isRecord(report.bySplit)) errors.push('report.bySplit is missing');
  else {
    for (const split of protocolSplits) {
      const group = report.bySplit[split];
      if (!isRecord(group)) errors.push(`report.bySplit.${split} is missing`);
      else {
        integer(`report.bySplit.${split}.cases`, group.cases, 1);
        if (group.cases !== splitCounts[split]) errors.push(`report.bySplit.${split}.cases does not match the fixture`);
        metricGroup(`report.bySplit.${split}`, group);
      }
    }
    for (const split of Object.keys(report.bySplit)) if (!protocolSplits.includes(split)) errors.push(`report.bySplit has unsupported split ${split}`);
  }
  if (!isRecord(report.byKind)) errors.push('report.byKind is missing');
  else for (const [kind, group] of Object.entries(report.byKind)) {
    integer(`report.byKind.${kind}.cases`, group?.cases, 1);
    metricGroup(`report.byKind.${kind}`, group);
  }
  integer('report.exactAndNavigationalSuccess', report.exactAndNavigationalSuccess);
  integer('report.exactAndNavigationalCases', report.exactAndNavigationalCases);
  if (report.exactAndNavigationalSuccess > report.exactAndNavigationalCases) errors.push('exact/navigational success exceeds its case count');

  const timing = report.latencyMs;
  if (!isRecord(timing)) errors.push('report.latencyMs is missing');
  else {
    finite('report.latencyMs.coldInit', timing.coldInit);
    const warm = timing.warm;
    if (!isRecord(warm)) errors.push('report.latencyMs.warm is missing');
    else {
      for (const field of ['p50', 'p95', 'max']) finite(`report.latencyMs.warm.${field}`, warm[field]);
      if (warm.p50 > warm.p95 || warm.p95 > warm.max) errors.push('warm latency percentiles are not ordered');
    }
    if (!isRecord(timing.byStratum)) errors.push('report.latencyMs.byStratum is missing');
    else for (const [stratum, group] of Object.entries(timing.byStratum)) {
      integer(`report.latencyMs.byStratum.${stratum}.cases`, group?.cases, 1);
      for (const field of ['p50', 'p95', 'max']) finite(`report.latencyMs.byStratum.${stratum}.${field}`, group?.[field]);
    }
  }

  const bytes = report.bytes;
  if (!isRecord(bytes)) errors.push('report.bytes is missing');
  else {
    for (const field of ['initRaw', 'queryRuntime']) finite(`report.bytes.${field}`, bytes[field]);
    if (!isRecord(bytes.artifacts) || !Object.keys(bytes.artifacts).length) errors.push('report.bytes.artifacts is missing');
    else for (const [artifact, sizes] of Object.entries(bytes.artifacts)) for (const field of ['raw', 'gzip', 'brotli']) finite(`report.bytes.artifacts.${artifact}.${field}`, sizes?.[field]);
  }
  if (!isRecord(report.memory)) errors.push('report.memory is missing');
  else finite('report.memory.rssBytes', report.memory.rssBytes);

  if (!Array.isArray(report.failures)) errors.push('report.failures is missing');
  else {
    const protectedCases = new Set(cases.filter((testCase) => testCase?.split === 'development' && ['exact', 'facet'].includes(testCase?.kind)).map((testCase) => testCase.id));
    if (report.failures.some((failure) => protectedCases.has(failure?.id))) errors.push('development exact/facet regression blocks adoption');
  }
  if (report.zeroResultAccuracy !== 1) errors.push('a judged zero-result query returned results');
  const thresholds = env ?? {};
  for (const name of ['SEARCH_QUALITY_MIN_RECALL', 'SEARCH_QUALITY_MIN_NDCG']) {
    const raw = thresholds[name];
    if (typeof raw !== 'string' || !raw.trim()) { errors.push(`${name} is required as approved governance`); continue; }
    const value = Number(raw);
    if (!Number.isFinite(value)) errors.push(`${name} must be finite`);
    else if (value < 0 || value > 1) errors.push(`${name} must be between 0 and 1`);
    else if (name.endsWith('RECALL') && typeof report.recallAt10 === 'number' && Number.isFinite(report.recallAt10) && report.recallAt10 < value) errors.push(`Recall@10 ${report.recallAt10.toFixed(4)} is below ${value.toFixed(4)}`);
    else if (name.endsWith('NDCG') && typeof report.ndcgAt10 === 'number' && Number.isFinite(report.ndcgAt10) && report.ndcgAt10 < value) errors.push(`NDCG@10 ${report.ndcgAt10.toFixed(4)} is below ${value.toFixed(4)}`);
  }
  return errors;
}
export function compareSearchQualityReports({ baseline, candidate, fixture, env = {} }) {
  const errors = [];
  if (!isRecord(baseline) || !isRecord(candidate)) return ['baseline and candidate reports are required'];
  for (const field of ['schemaVersion', 'releaseId', 'corpusSha256', 'fixtureSchemaVersion']) { const expected = field === 'fixtureSchemaVersion' ? fixture.schemaVersion : fixture.release?.[field]; if (baseline[field] !== candidate[field]) errors.push(`baseline/candidate release identity ${field} does not match`); if (field !== 'schemaVersion' && baseline[field] !== expected) errors.push(`baseline ${field} does not match the fixture`); if (field !== 'schemaVersion' && candidate[field] !== expected) errors.push(`candidate ${field} does not match the fixture`); }
  const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
  validateBenchmarkProtocol({ report: baseline, fixture, cases, errors });
  validateBenchmarkProtocol({ report: candidate, fixture, cases, errors });
  const protectedCases = new Set(cases.filter((testCase) => testCase?.split === 'development' && ['exact', 'facet'].includes(testCase?.kind)).map((testCase) => testCase.id));
  if (!Array.isArray(baseline.failures) || !Array.isArray(candidate.failures)) errors.push('baseline/candidate failures are missing');
  const failureIds = (report) => new Set(Array.isArray(report.failures) ? report.failures.map((failure) => failure?.id) : []);
  const baselineFailures = failureIds(baseline); const candidateFailures = failureIds(candidate);
  for (const id of protectedCases) if (candidateFailures.has(id) && !baselineFailures.has(id)) errors.push(`development exact/facet regression introduced: ${id}`);
  const baselineHoldout = baseline.bySplit?.holdout; const candidateHoldout = candidate.bySplit?.holdout;
  for (const field of ['recallAt10', 'ndcgAt10']) if (!Number.isFinite(baselineHoldout?.[field]) || !Number.isFinite(candidateHoldout?.[field])) errors.push(`holdout ${field} is missing or non-finite`);
  const delta = (field) => candidateHoldout?.[field] - baselineHoldout?.[field];
  const threshold = (name) => { const value = Number(env[name]); if (!Object.hasOwn(env, name) || !Number.isFinite(value) || value < 0 || value > 1) errors.push(`${name} must be an explicit finite value between 0 and 1`); return value; };
  const ndcgMinimum = threshold('SEARCH_QUALITY_MIN_HOLDOUT_NDCG_DELTA');
  const recallMinimum = threshold('SEARCH_QUALITY_MIN_HOLDOUT_RECALL_DELTA');
  if (!((delta('ndcgAt10') > 0 && delta('ndcgAt10') >= ndcgMinimum) || (delta('recallAt10') > 0 && delta('recallAt10') >= recallMinimum))) errors.push(`candidate has no approved holdout win (ΔNDCG@10 ${delta('ndcgAt10').toFixed(4)}, ΔRecall@10 ${delta('recallAt10').toFixed(4)})`);
  return errors;
}
function main() {
  const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [tsx, resolve(root, 'scripts', 'evaluate-search.ts'), '--json'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Search quality evaluation failed.\n');
    process.exit(result.status ?? 1);
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { process.stderr.write('Search quality evaluator returned invalid JSON.\n'); process.exit(1); }
  let fixture;
  try { fixture = JSON.parse(readFileSync(resolve(root, 'app/src/search/__fixtures__/relevance-set.json'), 'utf8')); } catch { process.stderr.write('Search quality fixture could not be read.\n'); process.exit(1); }
  const errors = validateSearchQualityGate({
    report,
    fixture,
    env: { ...loadSearchQualityThresholds(), ...process.env },
  });
  const baselinePath = process.env.SEARCH_QUALITY_BASELINE_REPORT;
  if (baselinePath) {
    try {
      const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
      errors.push(...compareSearchQualityReports({ baseline, candidate: report, fixture, env: process.env }));
    } catch { errors.push('baseline search quality report could not be read'); }
  }
  if (errors.length > 0) {
    console.error(`Search quality gate failed:\n${errors.join('\n')}`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(`Search quality passed: ${report.cases} valid cases; Recall@10 ${(report.recallAt10 * 100).toFixed(2)}%; NDCG@10 ${report.ndcgAt10.toFixed(4)}; MRR ${report.mrr.toFixed(4)}; exact/navigational top-10 ${report.exactAndNavigationalSuccess}/${report.exactAndNavigationalCases}; p95 ${report.latencyMs.warm.p95.toFixed(2)}ms.`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'check-search-quality.mjs')) main();
