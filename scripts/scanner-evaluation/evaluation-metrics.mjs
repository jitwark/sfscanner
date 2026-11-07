import { wilson95 } from '../../pipeline/calibration/v2-metrics.ts';
import { adjudicationEvidenceDigest, readAdjudicationEvidence, settledEvidenceByCase } from './label-evidence.mjs';

/**
 * Split-aware evaluation metrics for Q10.2. The engine is pure: it takes already adjudicated
 * cases, the settled adjudication evidence those cases rest on, and an optional frozen baseline
 * observation per case, and never reads labels, bodies, the clock or the environment. A family
 * belongs to exactly one split, so a DEV case can never fill a HOLDOUT denominator.
 *
 * The expected label is not taken on the caller's word: every contributing case needs a settled
 * adjudication naming the same case (`label-evidence.mjs`), and one that names a different label is
 * a contradiction and refused. A case that lacks settled adjudication counts as unresolved, which
 * keeps the report INSUFFICIENT_EVIDENCE rather than turning an assertion into a metric. Evidence
 * binds by case identity here because a case carries no source digest; binding a label to the exact
 * bytes it judged is the inventory's job (`evaluation-inventory.mjs`), which requires the
 * adjudication's provenance digest to equal the row's own input digest.
 */

export const EVALUATION_METRICS_SCHEMA = 'evaluation-metrics-v2';
const SPLITS = Object.freeze(['DEV', 'HOLDOUT']);
const EXPECTED = Object.freeze(['POSITIVE', 'NEGATIVE', 'EXCLUDED']);
const OBSERVED = Object.freeze(['POSITIVE', 'NEGATIVE', 'UNKNOWN']);
const MAX_CASES = 100_000;
const MIN_POSITIVES = 20;
const MIN_NEGATIVES = 20;
const MIN_PRECISION = 0.95;
const MIN_RECALL = 0.90;

const fail = (message) => { throw new TypeError(message); };
const text = (value, label) => { if (typeof value !== 'string' || value.length === 0 || value.length > 255) fail(`${label} must be a non-empty string.`); return value; };
const enumValue = (value, allowed, label) => { if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is not admitted.`); return value; };

function readCases(input) {
  if (!Array.isArray(input) || input.length > MAX_CASES) fail('cases must be a bounded array.');
  const seen = new Set();
  return input.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`cases[${index}] must be an object.`);
    const caseId = text(raw.caseId, `cases[${index}].caseId`);
    if (seen.has(caseId)) fail(`duplicate case ID ${caseId}.`);
    seen.add(caseId);
    return Object.freeze({
      caseId,
      familyId: text(raw.familyId, `cases[${index}].familyId`),
      split: enumValue(raw.split, SPLITS, `cases[${index}].split`),
      expected: enumValue(raw.expected, EXPECTED, `cases[${index}].expected`),
      observed: enumValue(raw.observed, OBSERVED, `cases[${index}].observed`),
    });
  });
}

function readBaseline(input, caseIds) {
  if (input === undefined) return null;
  if (!Array.isArray(input) || input.length > MAX_CASES) fail('baseline must be a bounded array.');
  const result = new Map();
  for (const [index, raw] of input.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`baseline[${index}] must be an object.`);
    const caseId = text(raw.caseId, `baseline[${index}].caseId`);
    if (!caseIds.has(caseId)) fail(`baseline references unknown case ${caseId}.`);
    if (result.has(caseId)) fail(`duplicate baseline case ${caseId}.`);
    result.set(caseId, enumValue(raw.observed, OBSERVED, `baseline[${index}].observed`));
  }
  return result;
}

function emptyCounts() {
  return { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0, excluded: 0, eligiblePositives: 0, eligibleNegatives: 0 };
}

function add(counts, item) {
  if (item.expected === 'EXCLUDED') { counts.excluded += 1; return; }
  if (item.observed === 'UNKNOWN') { counts.unknown += 1; return; }
  if (item.expected === 'POSITIVE') {
    counts.eligiblePositives += 1;
    if (item.observed === 'POSITIVE') counts.tp += 1; else counts.fn += 1;
  } else {
    counts.eligibleNegatives += 1;
    if (item.observed === 'POSITIVE') counts.fp += 1; else counts.tn += 1;
  }
}

const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
function interval(successes, total) {
  const bounds = wilson95(successes, total);
  return bounds === null ? null : Object.freeze({ lower: bounds[0], upper: bounds[1], confidence: 0.95, method: 'WILSON' });
}
function status(counts) {
  return counts.eligiblePositives >= MIN_POSITIVES && counts.eligibleNegatives >= MIN_NEGATIVES && counts.unknown === 0 ? 'READY' : 'INSUFFICIENT_EVIDENCE';
}
function admissionReasons(counts) {
  const reasons = [];
  if (counts.eligiblePositives < MIN_POSITIVES) reasons.push(`positive denominator ${counts.eligiblePositives} < ${MIN_POSITIVES}`);
  if (counts.eligibleNegatives < MIN_NEGATIVES) reasons.push(`negative denominator ${counts.eligibleNegatives} < ${MIN_NEGATIVES}`);
  if (counts.unknown > 0) reasons.push(`${counts.unknown} unresolved case(s)`);
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  if (precision !== null && precision < MIN_PRECISION) reasons.push(`precision ${precision.toFixed(4)} < ${MIN_PRECISION}`);
  if (recall !== null && recall < MIN_RECALL) reasons.push(`recall ${recall.toFixed(4)} < ${MIN_RECALL}`);
  return reasons;
}

function paired(item, baseline) {
  if (baseline === null || item.expected === 'EXCLUDED') return null;
  const prior = baseline.get(item.caseId);
  if (prior === undefined || prior === 'UNKNOWN' || item.observed === 'UNKNOWN') return null;
  const correct = (observed) => observed === item.expected;
  return { before: correct(prior), after: correct(item.observed), regressed: correct(prior) && !correct(item.observed), improved: !correct(prior) && correct(item.observed) };
}

/**
 * The gate that makes the caller's expected label an adjudicated fact. A case with no settled
 * adjudication keeps its observed value but is counted as unresolved, so it can never fill a
 * denominator; a settled adjudication that names a different label than the case asserts is a
 * contradiction and is refused rather than averaged.
 */
function attributedCases(cases, evidence) {
  const settled = settledEvidenceByCase(evidence);
  let unauthenticated = 0;
  const attributed = cases.map((item) => {
    if (item.expected === 'EXCLUDED') return item;
    const record = settled.get(item.caseId);
    if (record === undefined) {
      unauthenticated += 1;
      return Object.freeze({ ...item, observed: 'UNKNOWN' });
    }
    if (record.label !== item.expected) fail(`case ${item.caseId} expected label disagrees with its settled adjudication.`);
    return item;
  });
  return { cases: Object.freeze(attributed), unauthenticated };
}

export function computeEvaluationMetrics(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('input must be an object.');
  const evidence = readAdjudicationEvidence(input.adjudications);
  const { cases, unauthenticated } = attributedCases(readCases(input.cases), evidence);
  const baseline = readBaseline(input.baseline, new Set(cases.map(({ caseId }) => caseId)));
  const familySplit = new Map();
  for (const item of cases) {
    const prior = familySplit.get(item.familyId);
    if (prior !== undefined && prior !== item.split) fail(`family ${item.familyId} leaks across DEV and HOLDOUT.`);
    familySplit.set(item.familyId, item.split);
  }
  const families = new Map();
  for (const familyId of [...familySplit.keys()].sort()) families.set(familyId, { split: familySplit.get(familyId), counts: emptyCounts(), pairs: 0, regressions: 0, improvements: 0 });
  for (const item of cases) {
    const family = families.get(item.familyId);
    add(family.counts, item);
    const comparison = paired(item, baseline);
    if (comparison !== null) {
      family.pairs += 1;
      if (comparison.regressed) family.regressions += 1;
      if (comparison.improved) family.improvements += 1;
    }
  }
  const splits = Object.fromEntries(SPLITS.map((split) => [split, emptyCounts()]));
  const familyRows = [];
  for (const [familyId, family] of families) {
    for (const key of Object.keys(family.counts)) splits[family.split][key] += family.counts[key];
    const precision = ratio(family.counts.tp, family.counts.tp + family.counts.fp);
    const recall = ratio(family.counts.tp, family.counts.tp + family.counts.fn);
    familyRows.push(Object.freeze({
      familyId, split: family.split, counts: Object.freeze({ ...family.counts }),
      precision, recall,
      precisionInterval: interval(family.counts.tp, family.counts.tp + family.counts.fp),
      recallInterval: interval(family.counts.tp, family.counts.tp + family.counts.fn),
      status: status(family.counts),
      paired: Object.freeze({ pairs: family.pairs, regressions: family.regressions, improvements: family.improvements }),
      admissionReasons: Object.freeze(admissionReasons(family.counts)),
    }));
  }
  const splitRows = Object.fromEntries(SPLITS.map((split) => {
    const counts = splits[split];
    return [split, Object.freeze({
      counts: Object.freeze({ ...counts }),
      precision: ratio(counts.tp, counts.tp + counts.fp),
      recall: ratio(counts.tp, counts.tp + counts.fn),
      precisionInterval: interval(counts.tp, counts.tp + counts.fp),
      recallInterval: interval(counts.tp, counts.tp + counts.fn),
      status: status(counts),
    })];
  }));
  const total = cases.length;
  const excluded = [...families.values()].reduce((sum, family) => sum + family.counts.excluded, 0);
  const unknown = [...families.values()].reduce((sum, family) => sum + family.counts.unknown, 0);
  const holdoutFamilies = familyRows.filter(({ split }) => split === 'HOLDOUT');
  const reasons = [];
  if (unauthenticated > 0) reasons.push(`${unauthenticated} case(s) lack settled adjudication`);
  if (holdoutFamilies.length === 0) reasons.push('no HOLDOUT families');
  if (holdoutFamilies.some(({ status }) => status !== 'READY')) reasons.push('a HOLDOUT family lacks minimum eligible counts');
  if (holdoutFamilies.some(({ counts }) => counts.unknown > 0)) reasons.push('a HOLDOUT family has unresolved cases');
  if (holdoutFamilies.some(({ precision, recall }) => precision !== null && precision < MIN_PRECISION || recall !== null && recall < MIN_RECALL)) reasons.push('a HOLDOUT family misses precision/recall thresholds');
  if (familyRows.some(({ split, paired }) => split === 'HOLDOUT' && paired.regressions > 0)) reasons.push('a HOLDOUT family has paired regressions');
  return Object.freeze({
    schemaVersion: EVALUATION_METRICS_SCHEMA,
    adjudicationCount: evidence.length,
    adjudicationDigest: adjudicationEvidenceDigest(evidence),
    unauthenticatedCount: unauthenticated,
    caseCount: total,
    excludedCount: excluded,
    unknownCount: unknown,
    status: total === 0 ? 'INSUFFICIENT_EVIDENCE' : unknown > 0 || excluded > 0 ? 'PARTIAL' : 'READY',
    splits: Object.freeze(splitRows),
    families: Object.freeze(familyRows),
    admission: Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) }),
  });
}
