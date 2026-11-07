import type { CalibrationDispute } from './v2-lineage';
import type { V2CalibrationProvenance, V2ExpectedLabel, V2ExpectedRule } from './v2-case-schema';

export type V2AdjudicationStatus = 'AGREED' | 'RESOLVED' | 'DISPUTED' | 'HUMAN_REQUIRED' | 'INSUFFICIENT_EVIDENCE';
export type V2ReviewerDecision = {
  reviewer: string;
  label: V2ExpectedLabel;
  rationale: string;
  reviewedAt: string;
  rules?: readonly V2ExpectedRule[];
};
export type V2DisputeResolution = {
  reviewer: string;
  label: V2ExpectedLabel;
  rationale: string;
  reviewedAt: string;
  rules?: readonly V2ExpectedRule[];
};
export type V2AdjudicationInput = {
  caseId: string;
  provenance: V2CalibrationProvenance;
  decisions: readonly V2ReviewerDecision[];
  dispute?: CalibrationDispute;
  evidence?: 'SUFFICIENT' | 'INSUFFICIENT';
  resolution?: V2DisputeResolution;
};
export type V2Adjudication = {
  caseId: string;
  provenance: V2CalibrationProvenance;
  rights: { licence: string; permission: string };
  decisions: readonly V2ReviewerDecision[];
  status: V2AdjudicationStatus;
  disagreement: boolean;
  label?: V2ExpectedLabel;
  rules: readonly V2ExpectedRule[];
  resolution?: V2DisputeResolution;
};

const DIGEST = /^[0-9a-f]{64}$/;
const compare = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
function fail(message: string): never { throw new Error(`Calibration adjudication: ${message}`); }
function parseDispute(value: unknown): CalibrationDispute {
  if (value === 'NONE' || value === 'OPEN' || value === 'RESOLVED' || value === 'HUMAN_REQUIRED') return value;
  fail('dispute is invalid.');
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail(`${label} must be a plain object.`);
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${label}.${name} must be enumerable data.`);
    result[name] = descriptor.value;
  }
  return result;
}
function text(value: unknown, label: string, max = 8192): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/.test(value) && !/^[\u0000-\ud7ff\ue000-\uffff]*(?:[\ud800-\udbff][\udc00-\udfff][\u0000-\ud7ff\ue000-\uffff]*)*$/.test(value)) fail(`${label} must be safe non-empty text.`);
  return value;
}
function label(value: unknown, labelName: string): V2ExpectedLabel {
  if (value === 'POSITIVE' || value === 'NEGATIVE' || value === 'NEAR_MISS' || value === 'UNSUPPORTED') return value;
  fail(`${labelName} is invalid.`);
}
function rules(value: unknown, labelName: string): readonly V2ExpectedRule[] {
  if (!Array.isArray(value)) fail(`${labelName} must be an array.`);
  const seen = new Set<string>();
  const parsed = value.map((item, index) => {
    const raw = plain(item, `${labelName}[${index}]`);
    const ruleId = text(raw.ruleId, `${labelName}[${index}].ruleId`, 256);
    if (seen.has(ruleId)) fail(`${labelName} has duplicate rule IDs.`);
    seen.add(ruleId);
    return Object.freeze({ ruleId, label: label(raw.label, `${labelName}[${index}].label`) });
  }).sort((left, right) => compare(left.ruleId, right.ruleId));
  return Object.freeze(parsed);
}
function provenance(value: unknown): V2CalibrationProvenance {
  const raw = plain(value, 'provenance');
  const source = text(raw.source, 'provenance.source');
  const commit = text(raw.commit, 'provenance.commit');
  const path = text(raw.path, 'provenance.path');
  const licence = text(raw.licence, 'provenance.licence');
  const permission = text(raw.permission, 'provenance.permission');
  const digest = raw.digest;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) fail('provenance.digest must be a lowercase SHA-256 digest.');
  return Object.freeze({ source, commit, path, licence, permission, digest });
}
function decision(value: unknown, labelName: string): V2ReviewerDecision {
  const raw = plain(value, labelName);
  const parsedRules = raw.rules === undefined ? undefined : rules(raw.rules, `${labelName}.rules`);
  const reviewedAt = text(raw.reviewedAt, `${labelName}.reviewedAt`, 64);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) fail(`${labelName}.reviewedAt must be an ISO date.`);
  return Object.freeze({ reviewer: text(raw.reviewer, `${labelName}.reviewer`, 256), label: label(raw.label, `${labelName}.label`), rationale: text(raw.rationale, `${labelName}.rationale`), reviewedAt, ...(parsedRules === undefined ? {} : { rules: parsedRules }) });
}
function decisionKey(item: V2ReviewerDecision): string { return `${item.label}|${(item.rules ?? []).map((rule) => `${rule.ruleId}:${rule.label}`).join(',')}`; }
function sameRules(left: readonly V2ExpectedRule[], right: readonly V2ExpectedRule[]): boolean { return decisionKey({ label: 'POSITIVE', rules: left, reviewer: '', rationale: '', reviewedAt: '' }) === decisionKey({ label: 'POSITIVE', rules: right, reviewer: '', rationale: '', reviewedAt: '' }); }
function resolution(value: unknown): V2DisputeResolution {
  const parsed = decision(value, 'resolution');
  return Object.freeze({ reviewer: parsed.reviewer, label: parsed.label, rationale: parsed.rationale, reviewedAt: parsed.reviewedAt, ...(parsed.rules === undefined ? {} : { rules: parsed.rules }) });
}

export function isSettledAdjudication(value: Pick<V2Adjudication, 'status'>): boolean { return value.status === 'AGREED' || value.status === 'RESOLVED'; }

export function adjudicateCalibrationCase(input: unknown): V2Adjudication {
  const raw = plain(input, 'adjudication');
  const caseId = text(raw.caseId, 'caseId', 128);
  const normalizedProvenance = provenance(raw.provenance);
  if (!Array.isArray(raw.decisions)) fail('decisions are required.');
  const parsedDecisions = raw.decisions.map((item, index) => decision(item, `decisions[${index}]`)).sort((left, right) => compare(left.reviewer, right.reviewer));
  const reviewers = new Set<string>();
  for (const item of parsedDecisions) { if (reviewers.has(item.reviewer)) fail(`duplicate reviewer decision for ${item.reviewer}.`); reviewers.add(item.reviewer); }
  const dispute = raw.dispute === undefined ? 'NONE' : parseDispute(raw.dispute);
  const evidence = raw.evidence === undefined ? 'SUFFICIENT' : raw.evidence;
  if (evidence !== 'SUFFICIENT' && evidence !== 'INSUFFICIENT') fail('evidence is invalid.');
  const parsedResolution = raw.resolution === undefined ? undefined : resolution(raw.resolution);
  const keys = new Set(parsedDecisions.map(decisionKey));
  const disagreement = keys.size > 1;
  if (parsedResolution !== undefined && parsedDecisions.some((item) => item.reviewer === parsedResolution.reviewer)) fail('resolution reviewer must be independent.');
  if (parsedResolution !== undefined && !disagreement && parsedDecisions[0] !== undefined && (parsedDecisions[0].label !== parsedResolution.label || !sameRules(parsedDecisions[0].rules ?? [], parsedResolution.rules ?? []))) fail('resolution conflicts with reviewer decisions.');
  if (dispute === 'RESOLVED' && parsedResolution === undefined) fail('RESOLVED disputes require an explicit resolution.');
  let status: V2AdjudicationStatus;
  let settledLabel: V2ExpectedLabel | undefined;
  let settledRules: readonly V2ExpectedRule[] = Object.freeze([]);
  if (dispute === 'HUMAN_REQUIRED') status = 'HUMAN_REQUIRED';
  else if (evidence === 'INSUFFICIENT' || parsedDecisions.length < 2) status = 'INSUFFICIENT_EVIDENCE';
  else if (parsedResolution !== undefined && (disagreement || dispute === 'RESOLVED')) { status = 'RESOLVED'; settledLabel = parsedResolution.label; settledRules = parsedResolution.rules ?? Object.freeze([]); }
  else if (disagreement || dispute === 'OPEN') status = 'DISPUTED';
  else { status = 'AGREED'; settledLabel = parsedDecisions[0]!.label; settledRules = parsedDecisions[0]!.rules ?? Object.freeze([]); }
  return Object.freeze({ caseId, provenance: normalizedProvenance, rights: Object.freeze({ licence: normalizedProvenance.licence, permission: normalizedProvenance.permission }), decisions: Object.freeze(parsedDecisions), status, disagreement, ...(settledLabel === undefined ? {} : { label: settledLabel }), rules: settledRules, ...(parsedResolution === undefined ? {} : { resolution: parsedResolution }) });
}

export function adjudicateCalibrationCases(inputs: readonly unknown[]): readonly V2Adjudication[] {
  if (!Array.isArray(inputs)) fail('corpus must be an array.');
  const results = inputs.map(adjudicateCalibrationCase).sort((left, right) => compare(left.caseId, right.caseId));
  const seen = new Set<string>();
  for (const item of results) { if (seen.has(item.caseId)) fail(`duplicate case ID ${item.caseId}.`); seen.add(item.caseId); }
  return Object.freeze(results);
}

export function resolveCalibrationDispute(input: V2AdjudicationInput): V2Adjudication {
  if (input.resolution === undefined) fail('an explicit resolution is required.');
  return adjudicateCalibrationCase(input);
}
