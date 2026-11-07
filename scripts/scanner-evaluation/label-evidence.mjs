/**
 * The label-evidence gate for Q10.2 readiness.
 *
 * A label digest is a record that something was labelled; it is not evidence of who labelled it or
 * that two independent reviewers settled it. Readiness therefore consumes settle adjudication
 * evidence instead of a bare digest: a closed projection of the calibration adjudication record
 * (`pipeline/calibration/v2-adjudication.ts` is the authoritative validator for the full record).
 * The projection keeps the canonical field names and the canonical settlement semantics — AGREED
 * needs matching decisions, RESOLVED needs a resolution that is independent of the reviewers and
 * does not contradict a unanimous pair — and adds nothing the pipeline does not already require, so
 * a record the pipeline refuses cannot authenticate a label here.
 *
 * Trust in the reviewer identities themselves stays external, exactly as the plan says: this gate
 * makes a fabricated digest insufficient, not a determined forger impossible.
 */
import { comparePaths, fail, record, sha256 } from '../lib/release-artifacts.mjs';
import { canonicalJson } from '../lib/scanner-result-digest.mjs';

export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EVIDENCE_KEYS = Object.freeze(['caseId', 'status', 'label', 'decisions', 'resolution', 'provenance']);
const DECISION_KEYS = Object.freeze(['reviewer', 'label', 'rationale', 'reviewedAt']);
const PROVENANCE_KEYS = Object.freeze(['digest', 'licence', 'permission']);
const STATUSES = Object.freeze(['AGREED', 'RESOLVED', 'DISPUTED', 'HUMAN_REQUIRED', 'INSUFFICIENT_EVIDENCE']);
const LABELS = Object.freeze(['POSITIVE', 'NEGATIVE', 'NEAR_MISS', 'UNSUPPORTED']);
const SETTLED = Object.freeze(['AGREED', 'RESOLVED']);
const MAX_DECISIONS = 64;

const exactKeys = (value, keys, label) => {
  if (!record(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...keys].sort(comparePaths);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has keys outside the contract: ${actual.join(', ')}`);
  }
  return value;
};

const text = (value, label, max = 8192) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be safe non-empty text`);
  }
  return value;
};

const oneOf = (value, allowed, label) => {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join(', ')}`);
  return value;
};

const digestOf = (value, label) => {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
};

function reviewerDecision(value, index, label) {
  exactKeys(value, DECISION_KEYS, `${label}.decisions[${index}]`);
  const reviewedAt = text(value.reviewedAt, `${label}.decisions[${index}].reviewedAt`, 64);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(reviewedAt)) fail(`${label}.decisions[${index}].reviewedAt must be an ISO date`);
  return {
    reviewer: text(value.reviewer, `${label}.decisions[${index}].reviewer`, 256),
    label: oneOf(value.label, LABELS, `${label}.decisions[${index}].label`),
    rationale: text(value.rationale, `${label}.decisions[${index}].rationale`),
    reviewedAt,
  };
}

/** Rebuilt field by field, so an unknown key or an `undefined` can never reach the digest. */
function normalizedEvidence(value, index) {
  const label = `adjudication evidence ${index}`;
  exactKeys(value, EVIDENCE_KEYS, label);
  if (typeof value.caseId !== 'string' || !SAFE_IDENTIFIER.test(value.caseId)) fail(`${label}.caseId is not a safe identifier`);
  const status = oneOf(value.status, STATUSES, `${label}.status`);
  const settled = SETTLED.includes(status);
  const provenance = exactKeys(value.provenance, PROVENANCE_KEYS, `${label}.provenance`);
  const normalizedProvenance = {
    digest: digestOf(provenance.digest, `${label}.provenance.digest`),
    licence: text(provenance.licence, `${label}.provenance.licence`, 256),
    permission: text(provenance.permission, `${label}.provenance.permission`, 256),
  };
  if (!Array.isArray(value.decisions) || value.decisions.length > MAX_DECISIONS) fail(`${label}.decisions must be a bounded array`);
  const decisions = value.decisions.map((decision, position) => reviewerDecision(decision, position, label));
  const reviewers = new Set(decisions.map((decision) => decision.reviewer));
  if (reviewers.size !== decisions.length) fail(`${label} repeats a reviewer identity`);
  const resolution = value.resolution === null || value.resolution === undefined
    ? null
    : reviewerDecision(value.resolution, 0, `${label}.resolution`);
  if (resolution !== null) {
    // A resolver who also decided the case settles their own disagreement; the canonical adjudicator
    // refuses that record, so it can authenticate nothing here.
    if (reviewers.has(resolution.reviewer)) fail(`${label} resolves its own review: the resolution reviewer must be independent`);
    const unanimous = new Set(decisions.map((decision) => decision.label));
    if (unanimous.size === 1 && !unanimous.has(resolution.label)) fail(`${label} resolution conflicts with unanimous reviewer decisions`);
  }
  if (!settled) {
    if (value.label !== null) fail(`${label}.label must be null unless the adjudication is settled`);
    return { caseId: value.caseId, status, label: null, decisions, resolution, provenance: normalizedProvenance };
  }
  const settledLabel = oneOf(value.label, LABELS, `${label}.label`);
  if (decisions.length < 2) fail(`${label} needs at least two independent reviewer decisions`);
  if (status === 'AGREED' && decisions.some((decision) => decision.label !== settledLabel)) {
    fail(`${label} is AGREED but its decisions disagree`);
  }
  if (status === 'RESOLVED') {
    if (resolution === null) fail(`${label} is RESOLVED without a resolution`);
    if (resolution.label !== settledLabel) fail(`${label}.resolution disagrees with the settled label`);
  }
  return { caseId: value.caseId, status, label: settledLabel, decisions, resolution, provenance: normalizedProvenance };
}

/** Closes and validates the evidence set; identity-ordered so the digest cannot depend on input order. */
export function readAdjudicationEvidence(value) {
  if (!Array.isArray(value)) fail('adjudication evidence must be an array');
  const seen = new Set();
  const normalized = value.map(normalizedEvidence).map((item) => {
    if (seen.has(item.caseId)) fail(`adjudication evidence names one case twice: ${item.caseId}`);
    seen.add(item.caseId);
    return item;
  }).sort((left, right) => comparePaths(left.caseId, right.caseId));
  return Object.freeze(normalized.map((item) => Object.freeze({
    ...item,
    decisions: Object.freeze(item.decisions.map((decision) => Object.freeze(decision))),
    resolution: item.resolution === null ? null : Object.freeze(item.resolution),
    provenance: Object.freeze(item.provenance),
  })));
}

export const isSettledEvidence = (evidence) => SETTLED.includes(evidence.status);

/** The settled record for a case, or `undefined`. Unsettled evidence authenticates nothing. */
export function settledEvidenceByCase(evidence) {
  return new Map(evidence.filter(isSettledEvidence).map((item) => [item.caseId, item]));
}

/** Projects a canonical adjudication record onto the closed evidence shape without trusting it. */
export function adjudicationEvidenceOf(adjudication) {
  const decision = (item) => ({ reviewer: item.reviewer, label: item.label, rationale: item.rationale, reviewedAt: item.reviewedAt });
  return readAdjudicationEvidence([{
    caseId: adjudication.caseId,
    status: adjudication.status,
    label: adjudication.label ?? null,
    decisions: adjudication.decisions.map(decision),
    resolution: adjudication.resolution === undefined ? null : decision(adjudication.resolution),
    provenance: {
      digest: adjudication.provenance.digest,
      licence: adjudication.provenance.licence,
      permission: adjudication.provenance.permission,
    },
  }])[0];
}

/** Names exactly the evidence a receipt relied on; order-independent by construction. */
export const adjudicationEvidenceDigest = (evidence) => sha256(canonicalJson(evidence));
