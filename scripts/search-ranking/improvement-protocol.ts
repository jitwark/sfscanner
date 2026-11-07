import { createHash } from 'node:crypto';

export const RANKING_PROTOCOL_VERSION = 'search-ranking-improvement-v1';
export const DEFAULT_POLICY = Object.freeze({
  minHoldoutRecallGain: 0.05, minHoldoutNdcgGain: 0.02, minHoldoutMrrGain: 0,
  maxHoldoutMrrRegression: 0, maxExactRegression: 0, maxFacetRegression: 0,
  requireNoExactFacetCaseRegression: true,
});
export type Split = 'development' | 'holdout';
export type ExpectedJudgment = { id: string; relevance: 1 | 2 | 3; rationale: string; reviewer: string; reviewedOn: string; releaseId: string };
export type JudgedCase = { id: string; split: Split; kind: string; sort: 'relevance' | 'quality'; query: string; filters?: Readonly<Record<string, string | readonly string[]>>; expected: readonly ExpectedJudgment[] };
export type JudgedSet = { schemaVersion: string; release: { releaseId: string }; protocol: { tuningSplit: 'development'; holdoutSplit: 'holdout'; holdoutPolicy: 'untouched-evaluate-once'; queryKey: 'query+filters+sort-v1'; developmentQuerySetSha256: string; holdoutQuerySetSha256: string }; cases: readonly JudgedCase[] };
export type RankedResult = { caseId: string; ids: readonly string[] };
export type RankedResults = Readonly<Record<string, readonly string[]>> | readonly RankedResult[];
export type RankedRun = { label: string; version: string; releaseId: string; results: RankedResults; tunedCaseIds: readonly string[] };
export type RankingPolicy = typeof DEFAULT_POLICY;
export type MetricSummary = { cases: number; positiveCases: number; recallAt10: number; ndcgAt10: number; mrr: number; exactSuccess: number; exactCases: number; facetSuccess: number; facetCases: number; exactFacetSuccess: number; exactFacetCases: number; zeroResultAccuracy: number; queryHitRate: number };
export type RunMetrics = MetricSummary & { bySplit: Record<Split, MetricSummary>; byKind: Record<string, MetricSummary> };
export type CaseMetric = { top10: readonly string[]; recallAt10: number; ndcgAt10: number; mrr: number; exactSuccess: boolean | null; facetSuccess: boolean | null; zeroResultCorrect: boolean };
export type CaseComparison = { caseId: string; split: Split; kind: string; baseline: CaseMetric; candidate: CaseMetric };
export type RankingReport = { schemaVersion: string; releaseId: string | null; fixtureSchemaVersion: string | null; policy: RankingPolicy; tuning: { split: 'development'; tunedCaseIds: readonly string[]; holdoutUntouched: boolean }; baseline: { label: string; version: string; releaseId: string; metrics: RunMetrics | null }; candidate: { label: string; version: string; releaseId: string; metrics: RunMetrics | null }; comparison: { holdoutDeltas: { recallAt10: number; ndcgAt10: number; mrr: number; exactSuccessRate: number; facetSuccessRate: number }; caseComparisons: readonly CaseComparison[]; regressions: readonly string[] }; accepted: boolean; errors: readonly string[]; reportSha256: string };
export type RankingEvaluationInput = { judgedSet: JudgedSet; availableIds: readonly string[]; baseline: RankedRun; candidate: RankedRun; policy?: Partial<RankingPolicy> };

type JsonRecord = Record<string, unknown>; type ScoredCase = { judged: JudgedCase; metric: CaseMetric };
const splits: readonly Split[] = ['development', 'holdout'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const asString = (value: unknown) => typeof value === 'string' ? value : null;
const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort(compare);
const round = (value: number) => value === 0 ? 0 : Number(value.toFixed(12));
const sortedErrors = (errors: readonly string[]) => uniqueSorted(errors);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonicalValue(value[key])]));
  return value;
}
export function stableJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function canonicalFilters(filters: unknown): JsonRecord | null {
  if (filters === undefined) return {};
  if (!isRecord(filters)) return null;
  const normalized: JsonRecord = {};
  for (const key of Object.keys(filters).sort(compare)) {
    const value = filters[key];
    if (typeof value === 'string') normalized[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) normalized[key] = [...value].sort(compare);
    else return null;
  }
  return normalized;
}
export function canonicalQueryKey(testCase: Pick<JudgedCase, 'query' | 'filters' | 'sort'>): string | null {
  if (typeof testCase.query !== 'string' || !['relevance', 'quality'].includes(testCase.sort)) return null;
  const filters = canonicalFilters(testCase.filters);
  return filters === null ? null : JSON.stringify([testCase.query, filters, testCase.sort]);
}
export function querySetSha256(cases: readonly JudgedCase[], split: Split): string {
  return sha256(cases.filter((testCase) => testCase.split === split).map((testCase) => canonicalQueryKey(testCase)).filter((key): key is string => key !== null).sort(compare).join('\n'));
}

function validateFixture(input: RankingEvaluationInput, available: Set<string>): { cases: JudgedCase[]; errors: string[]; releaseId: string | null } {
  const errors: string[] = []; const fixture = isRecord(input.judgedSet) ? input.judgedSet : {} as JsonRecord;
  if (!isRecord(input.judgedSet)) errors.push('fixture must be an object');
  const release = isRecord(fixture.release) ? fixture.release : {}; const releaseId = asString(release.releaseId);
  const protocol = isRecord(fixture.protocol) ? fixture.protocol : {}; const rawCases = Array.isArray(fixture.cases) ? fixture.cases : [];
  if (fixture.schemaVersion !== 'relevance-set-v2') errors.push('fixture schemaVersion must be relevance-set-v2');
  if (!releaseId) errors.push('fixture release identity is missing');
  if (!Array.isArray(fixture.cases)) errors.push('fixture cases must be an array');
  const cases: JudgedCase[] = []; const caseIds = new Set<string>(); const queryOwners = new Map<string, { id: string; split: string }[]>();
  for (const [index, value] of rawCases.entries()) {
    if (!isRecord(value)) { errors.push(`case[${index}] must be an object`); continue; }
    const id = asString(value.id) ?? `case[${index}]`; const judged = value as unknown as JudgedCase;
    if (!asString(value.id)) errors.push(`${id} has a missing case ID`);
    else if (caseIds.has(id)) errors.push(`${id} duplicates a case ID`); else caseIds.add(id);
    if (!splits.includes(value.split as Split)) errors.push(`${id} has an invalid split`);
    if (typeof value.query !== 'string' || canonicalFilters(value.filters) === null) errors.push(`${id} has invalid canonical query fields`);
    if (!['relevance', 'quality'].includes(String(value.sort))) errors.push(`${id} has an invalid sort`);
    const key = canonicalQueryKey(judged); if (key) queryOwners.set(key, [...(queryOwners.get(key) ?? []), { id, split: String(value.split) }]);
    if (!Array.isArray(value.expected)) errors.push(`${id} expected judgments must be an array`);
    const expected = Array.isArray(value.expected) ? value.expected : []; const expectedIds = new Set<string>();
    for (const judgment of expected) {
      // `asString` narrows nothing on `judgment.id` itself, so bind the narrowed
      // value rather than re-reading the `unknown` property three more times.
      const judgmentId = isRecord(judgment) ? asString(judgment.id) : undefined;
      if (!judgmentId) { errors.push(`${id} has an invalid expected judgment`); continue; }
      if (expectedIds.has(judgmentId)) errors.push(`${id} duplicate expected ID: ${judgmentId}`); else expectedIds.add(judgmentId);
      if (!available.has(judgmentId)) errors.push(`${id} expected ID missing from available release: ${judgmentId}`);
      const complete = ['rationale', 'reviewer', 'reviewedOn', 'releaseId'].every((field) => typeof judgment[field] === 'string' && Boolean(judgment[field]));
      if (!([1, 2, 3] as unknown[]).includes(judgment.relevance) || !complete || judgment.releaseId !== releaseId) errors.push(`${id} has an invalid or stale judgment: ${judgmentId}`);
    }
    if (asString(value.id) && splits.includes(value.split as Split)) cases.push(judged);
  }
  for (const [key, owners] of [...queryOwners.entries()].sort(([a], [b]) => compare(a, b))) {
    const ownerSplits = uniqueSorted(owners.map((owner) => owner.split)); const labels = owners.map((owner) => owner.id).sort(compare).join(', ');
    if (owners.length > 1 && ownerSplits.length > 1) errors.push(`canonical query key contamination between development and holdout (${labels})`);
    else if (owners.length > 1) errors.push(`duplicate canonical query key in ${ownerSplits[0]} (${labels})`);
  }
  for (const split of splits) if (!cases.some((testCase) => testCase.split === split)) errors.push(`fixture missing ${split} split`);
  const expectedProtocol = { tuningSplit: 'development', holdoutSplit: 'holdout', holdoutPolicy: 'untouched-evaluate-once', queryKey: 'query+filters+sort-v1' };
  for (const [key, expected] of Object.entries(expectedProtocol)) if (protocol[key] !== expected) errors.push(`protocol.${key} must be ${expected}`);
  for (const split of splits) { const field = `${split}QuerySetSha256`; if (protocol[field] !== querySetSha256(cases, split)) errors.push(`protocol.${field} is stale or missing`); }
  if (cases.length === 0) errors.push('fixture has no valid judged cases');
  return { cases, errors, releaseId };
}

function normalizeResults(raw: unknown, cases: readonly JudgedCase[], available: Set<string>, label: string, errors: string[]): Map<string, readonly string[]> | null {
  const rows: Array<{ caseId: unknown; ids: unknown }> = [];
  if (Array.isArray(raw)) for (const row of raw) rows.push({ caseId: isRecord(row) ? row.caseId : undefined, ids: isRecord(row) ? row.ids : undefined });
  else if (isRecord(raw)) for (const caseId of Object.keys(raw).sort(compare)) rows.push({ caseId, ids: raw[caseId] });
  else { errors.push(`${label} results must be an object or array`); return null; }
  const known = new Set(cases.map((testCase) => testCase.id)); const seen = new Set<string>(); const normalized = new Map<string, readonly string[]>();
  for (const row of rows) {
    const caseId = asString(row.caseId); if (!caseId) { errors.push(`${label} has an invalid case output`); continue; }
    if (seen.has(caseId)) errors.push(`${label} duplicate case output: ${caseId}`); else seen.add(caseId);
    if (!known.has(caseId)) { errors.push(`${label} unknown case output: ${caseId}`); continue; }
    if (!Array.isArray(row.ids) || row.ids.length > 1000 || row.ids.some((id) => typeof id !== 'string' || !id.trim())) { errors.push(`${label} invalid result IDs for case: ${caseId}`); continue; }
    const ids = row.ids as string[]; if (new Set(ids).size !== ids.length) errors.push(`${label} duplicate result ID for case: ${caseId}`);
    for (const id of ids) if (!available.has(id)) errors.push(`${label} result ID missing from available release: ${id}`);
    normalized.set(caseId, [...ids]);
  }
  for (const testCase of cases) if (!seen.has(testCase.id)) errors.push(`${label} missing case output: ${testCase.id}`);
  return normalized;
}
function validateRun(raw: RankedRun, cases: readonly JudgedCase[], available: Set<string>, releaseId: string | null, label: string, errors: string[]): Map<string, readonly string[]> | null {
  const run = raw as unknown as JsonRecord; if (!isRecord(run)) { errors.push(`${label} run is missing`); return null; }
  if (run.releaseId !== releaseId) errors.push(`${label} release identity does not match fixture`);
  if (!asString(run.label) || !asString(run.version)) errors.push(`${label} label and version are required`);
  if (!Array.isArray(run.tunedCaseIds)) errors.push(`${label} tunedCaseIds must be an array`);
  else { const tuned = run.tunedCaseIds; if (tuned.some((id) => typeof id !== 'string') || new Set(tuned).size !== tuned.length) errors.push(`${label} tunedCaseIds are invalid`); for (const id of tuned) { const testCase = cases.find((item) => item.id === id); if (!testCase) errors.push(`${label} tuned unknown case: ${id}`); else if (testCase.split !== 'development') errors.push(`${label} tuned holdout case: ${id}`); } }
  return normalizeResults(run.results, cases, available, label, errors);
}

const emptySummary = (): MetricSummary => ({ cases: 0, positiveCases: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0, exactSuccess: 0, exactCases: 0, facetSuccess: 0, facetCases: 0, exactFacetSuccess: 0, exactFacetCases: 0, zeroResultAccuracy: 1, queryHitRate: 1 });
function scoreCase(judged: JudgedCase, ids: readonly string[]): CaseMetric {
  const top10 = ids.slice(0, 10); const grades = new Map(judged.expected.map((item) => [item.id, item.relevance])); const expectedIds = new Set(grades.keys());
  const hits = top10.filter((id) => expectedIds.has(id)).length; const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 10).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const actual = top10.reduce((sum, id, index) => sum + (2 ** (grades.get(id) ?? 0) - 1) / Math.log2(index + 2), 0); const rank = top10.findIndex((id) => expectedIds.has(id));
  return { top10, recallAt10: judged.expected.length ? hits / judged.expected.length : top10.length ? 0 : 1, ndcgAt10: ideal ? actual / ideal : top10.length ? 0 : 1, mrr: rank < 0 ? 0 : 1 / (rank + 1), exactSuccess: ['exact', 'navigational'].includes(judged.kind) ? hits > 0 : null, facetSuccess: judged.kind === 'facet' ? hits > 0 : null, zeroResultCorrect: judged.expected.length === 0 && top10.length === 0 };
}
function summarize(rows: readonly ScoredCase[]): MetricSummary {
  const out = emptySummary(); out.cases = rows.length; out.positiveCases = rows.filter((row) => row.judged.expected.length > 0).length;
  for (const row of rows) { out.recallAt10 += row.metric.recallAt10; out.ndcgAt10 += row.metric.ndcgAt10; out.mrr += row.metric.mrr; if (row.metric.exactSuccess !== null) { out.exactCases++; if (row.metric.exactSuccess) out.exactSuccess++; } if (row.metric.facetSuccess !== null) { out.facetCases++; if (row.metric.facetSuccess) out.facetSuccess++; } if (row.metric.exactSuccess !== null || row.metric.facetSuccess !== null) { out.exactFacetCases++; if (row.metric.exactSuccess || row.metric.facetSuccess) out.exactFacetSuccess++; } }
  const zeros = rows.filter((row) => row.judged.expected.length === 0); const hits = rows.filter((row) => row.judged.expected.length > 0 && row.metric.recallAt10 > 0).length;
  if (rows.length) { out.recallAt10 /= rows.length; out.ndcgAt10 /= rows.length; out.mrr /= rows.length; } out.zeroResultAccuracy = zeros.length ? zeros.filter((row) => row.metric.zeroResultCorrect).length / zeros.length : 1; out.queryHitRate = out.positiveCases ? hits / out.positiveCases : 1;
  for (const key of ['recallAt10', 'ndcgAt10', 'mrr', 'zeroResultAccuracy', 'queryHitRate'] as const) out[key] = round(out[key]); return out;
}
function buildMetrics(cases: readonly JudgedCase[], results: Map<string, readonly string[]>): { metrics: RunMetrics; rows: ScoredCase[] } {
  const rows = [...cases].sort((a, b) => compare(a.id, b.id)).map((judged) => ({ judged, metric: scoreCase(judged, results.get(judged.id) ?? []) }));
  const bySplit = Object.fromEntries(splits.map((split) => [split, summarize(rows.filter((row) => row.judged.split === split))])) as Record<Split, MetricSummary>;
  const kinds = uniqueSorted(rows.map((row) => row.judged.kind)); const byKind = Object.fromEntries(kinds.map((kind) => [kind, summarize(rows.filter((row) => row.judged.kind === kind))]));
  return { rows, metrics: { ...summarize(rows), bySplit, byKind } };
}
const rate = (success: number, cases: number) => cases ? success / cases : 1;

export function evaluateRankingImprovement(input: RankingEvaluationInput): RankingReport {
  const available = Array.isArray(input.availableIds) ? new Set(input.availableIds.filter((id): id is string => typeof id === 'string' && id.length > 0)) : new Set<string>(); const fixture = validateFixture(input, available); const errors = [...fixture.errors];
  const baselineMap = validateRun(input.baseline, fixture.cases, available, fixture.releaseId, 'baseline', errors); const candidateMap = validateRun(input.candidate, fixture.cases, available, fixture.releaseId, 'candidate', errors);
  const baseline = baselineMap && fixture.errors.length === 0 ? buildMetrics(fixture.cases, baselineMap) : null; const candidate = candidateMap && fixture.errors.length === 0 ? buildMetrics(fixture.cases, candidateMap) : null;
  const policy = { ...DEFAULT_POLICY, ...(isRecord(input.policy) ? input.policy : {}) } as RankingPolicy; for (const [key, value] of Object.entries(policy)) if (typeof value !== 'boolean' && (!Number.isFinite(value) || value < 0)) errors.push(`policy.${key} must be a non-negative finite number`);
  const tunedCaseIds = Array.isArray((input.candidate as unknown as JsonRecord)?.tunedCaseIds) ? ((input.candidate as unknown as JsonRecord).tunedCaseIds as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  const caseComparisons: CaseComparison[] = []; const regressions: string[] = [];
  if (baseline && candidate) for (const [index, judged] of [...fixture.cases].sort((a, b) => compare(a.id, b.id)).entries()) { const b = baseline.rows[index]!.metric; const c = candidate.rows[index]!.metric; caseComparisons.push({ caseId: judged.id, split: judged.split, kind: judged.kind, baseline: b, candidate: c }); if (policy.requireNoExactFacetCaseRegression && ((b.exactSuccess === true && c.exactSuccess === false) || (b.facetSuccess === true && c.facetSuccess === false))) regressions.push(`${judged.id}: exact/facet success regressed`); }
  const bHoldout = baseline?.metrics.bySplit.holdout ?? emptySummary(); const cHoldout = candidate?.metrics.bySplit.holdout ?? emptySummary(); const holdoutDeltas = { recallAt10: round(cHoldout.recallAt10 - bHoldout.recallAt10), ndcgAt10: round(cHoldout.ndcgAt10 - bHoldout.ndcgAt10), mrr: round(cHoldout.mrr - bHoldout.mrr), exactSuccessRate: round(rate(cHoldout.exactSuccess, cHoldout.exactCases) - rate(bHoldout.exactSuccess, bHoldout.exactCases)), facetSuccessRate: round(rate(cHoldout.facetSuccess, cHoldout.facetCases) - rate(bHoldout.facetSuccess, bHoldout.facetCases)) };
  if (baseline && candidate && errors.length === 0) { if (holdoutDeltas.recallAt10 < policy.minHoldoutRecallGain) errors.push(`holdout Recall@10 gain ${holdoutDeltas.recallAt10} is below required ${policy.minHoldoutRecallGain}`); if (holdoutDeltas.ndcgAt10 < policy.minHoldoutNdcgGain) errors.push(`holdout NDCG@10 gain ${holdoutDeltas.ndcgAt10} is below required ${policy.minHoldoutNdcgGain}`); if (holdoutDeltas.mrr < -policy.maxHoldoutMrrRegression || holdoutDeltas.mrr < policy.minHoldoutMrrGain) errors.push(`holdout MRR change ${holdoutDeltas.mrr} fails non-regression/win policy`); const bAll = baseline.metrics; const cAll = candidate.metrics; if (rate(cAll.exactSuccess, cAll.exactCases) < rate(bAll.exactSuccess, bAll.exactCases) - policy.maxExactRegression) errors.push('exact success rate regressed'); if (rate(cAll.facetSuccess, cAll.facetCases) < rate(bAll.facetSuccess, bAll.facetCases) - policy.maxFacetRegression) errors.push('facet success rate regressed'); }
  errors.push(...regressions);
  const runSummary = (run: RankedRun, metrics: RunMetrics | null) => ({ label: asString((run as unknown as JsonRecord)?.label) ?? '', version: asString((run as unknown as JsonRecord)?.version) ?? '', releaseId: asString((run as unknown as JsonRecord)?.releaseId) ?? '', metrics });
  const unsigned = { schemaVersion: RANKING_PROTOCOL_VERSION, releaseId: fixture.releaseId, fixtureSchemaVersion: asString((input.judgedSet as unknown as JsonRecord)?.schemaVersion), policy, tuning: { split: 'development' as const, tunedCaseIds: uniqueSorted(tunedCaseIds), holdoutUntouched: !tunedCaseIds.some((id) => fixture.cases.find((testCase) => testCase.id === id)?.split === 'holdout') }, baseline: runSummary(input.baseline, baseline?.metrics ?? null), candidate: runSummary(input.candidate, candidate?.metrics ?? null), comparison: { holdoutDeltas, caseComparisons, regressions: sortedErrors(regressions) }, accepted: errors.length === 0, errors: sortedErrors(errors) };
  return { ...unsigned, reportSha256: sha256(stableJson(unsigned)) };
}
