/**
 * Pure evaluation inventory: verified families share a deterministic holdout
 * split; unresolved identities remain unassigned and cannot establish readiness.
 * Source availability and historical labels are retained, not inferred.
 *
 * A recorded label digest is not evidence of adjudication, so readiness needs a
 * settled adjudication record bound to the row's own source digest
 * (`label-evidence.mjs`). A caller-supplied digest alone can never reach READY.
 */
import { comparePaths, fail, record, sha256 } from '../lib/release-artifacts.mjs';
import { canonicalJson } from '../lib/scanner-result-digest.mjs';
import { SAFE_IDENTIFIER, adjudicationEvidenceDigest, readAdjudicationEvidence, settledEvidenceByCase } from './label-evidence.mjs';

const DIGEST = /^[a-f0-9]{64}$/u;
const SCHEMA_VERSION = 'evaluation-inventory-v3';
const COHORTS = Object.freeze(['BUILTIN', 'THIRD_PARTY', 'UNAVAILABLE', 'MALFORMED']);
const STATES = Object.freeze(['BODY_AVAILABLE', 'SOURCE_UNAVAILABLE', 'NO_BODY', 'MALFORMED', 'REFUSED']);
const SPLITS = Object.freeze(['DEVELOPMENT', 'HOLDOUT', 'UNASSIGNED']);
const IDENTITIES = Object.freeze(['VERIFIED', 'UNRESOLVED']);
const FAMILY_REASONS = Object.freeze(['GITHUB_FAMILY_UNRESOLVED', 'NO_BODY_MAP_IDENTITY']);
const ROW_KEYS = Object.freeze(['entryId', 'cohort', 'familyId', 'familyIdentity', 'familyReason', 'inputDigest', 'labelDigest', 'state']);
const INVENTORY_KEYS = Object.freeze(['schemaVersion', 'inventoryDigest', 'adjudicationCount', 'adjudicationDigest', 'rows', 'splitCounts', 'stateCounts', 'cohortCounts', 'familyIdentityCounts', 'labelledRowCount', 'labelledHoldoutCount', 'authenticatedRowCount', 'authenticatedHoldoutCount', 'status', 'reasons']);
const HOLDOUT_STRIDE = 5;

function exactKeys(value, keys, label) {
  if (!record(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...keys].sort(comparePaths);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has keys outside the contract: ${actual.join(', ')}`);
  }
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join(', ')}`);
  return value;
}

/** Rebuilt field by field, so an unknown key or an `undefined` can never reach the digest. */
function normalizedRow(value, index) {
  const label = `inventory row ${index}`;
  exactKeys(value, ROW_KEYS, label);
  if (typeof value.entryId !== 'string' || !SAFE_IDENTIFIER.test(value.entryId)) fail(`${label} entryId is not a safe identifier`);
  const state = oneOf(value.state, STATES, `${label} state`);
  const { inputDigest, labelDigest, familyId, familyReason } = value;
  if (inputDigest !== null && (typeof inputDigest !== 'string' || !DIGEST.test(inputDigest))) fail(`${label} inputDigest is invalid`);
  if (state === 'BODY_AVAILABLE' && inputDigest === null) fail(`${label} body requires an inputDigest`);
  if (labelDigest !== null && (typeof labelDigest !== 'string' || !DIGEST.test(labelDigest))) fail(`${label} labelDigest is invalid`);
  const familyIdentity = oneOf(value.familyIdentity, IDENTITIES, `${label} familyIdentity`);
  if (familyIdentity === 'VERIFIED') {
    if (typeof familyId !== 'string' || !SAFE_IDENTIFIER.test(familyId) || familyReason !== null) fail(`${label} verified family is invalid`);
  } else {
    if (familyId !== null) fail(`${label} unresolved family must have a null familyId`);
    oneOf(familyReason, FAMILY_REASONS, `${label} familyReason`);
  }
  return {
    entryId: value.entryId,
    cohort: oneOf(value.cohort, COHORTS, `${label} cohort`),
    familyId,
    familyIdentity,
    familyReason,
    inputDigest,
    labelDigest,
    state,
  };
}

/**
 * Two spellings of one family would let a single upstream family land on both
 * sides of the split, so a case-insensitive repeat is refused instead of trusted.
 */
function checkedRows(rows) {
  if (!Array.isArray(rows)) fail('evaluation inventory rows must be an array');
  if (rows.length === 0) fail('evaluation inventory needs at least one row');
  const normalized = rows.map(normalizedRow);
  const digests = new Set(), entries = new Set(), spellings = new Map();
  for (const row of normalized) {
    if (entries.has(row.entryId)) fail(`evaluation inventory has a duplicate entryId: ${row.entryId}`);
    entries.add(row.entryId);
    if (row.inputDigest !== null) {
      if (digests.has(row.inputDigest)) fail(`evaluation inventory has a duplicate inputDigest: ${row.inputDigest}`);
      digests.add(row.inputDigest);
    }
    if (row.familyIdentity !== 'VERIFIED') continue;
    const folded = row.familyId.toLowerCase();
    const known = spellings.get(folded);
    if (known !== undefined && known !== row.familyId) fail(`evaluation inventory names one family twice: ${known} and ${row.familyId}`);
    spellings.set(folded, row.familyId);
  }
  return normalized;
}

function sortedFamilies(rows) {
  return [...new Set(rows.filter((row) => row.familyIdentity === 'VERIFIED').map((row) => row.familyId))].sort(comparePaths);
}

/** The 5th, 10th, … ID counted back from the end; five families hold out the first. */
function holdoutFamilies(familyIds) {
  const holdout = new Set();
  const last = familyIds.length - 1;
  for (let distance = HOLDOUT_STRIDE - 1; distance <= last; distance += HOLDOUT_STRIDE) {
    holdout.add(familyIds[last - distance]);
  }
  return holdout;
}

function counted(keys, rows, field) {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) counts[row[field]] += 1;
  return counts;
}

function evidenceReasons(splitCounts, labelledHoldoutCount, authenticatedHoldoutCount) {
  const reasons = [];
  if (splitCounts.HOLDOUT === 0) reasons.push('NO_HOLDOUT');
  else if (labelledHoldoutCount < splitCounts.HOLDOUT) reasons.push('UNLABELLED_HOLDOUT');
  if (authenticatedHoldoutCount < splitCounts.HOLDOUT) reasons.push('UNATTRIBUTED_HOLDOUT');
  if (splitCounts.UNASSIGNED > 0) reasons.push('UNRESOLVED_FAMILY');
  return reasons;
}

function deepFreeze(value) {
  if (record(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  } else if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildEvaluationInventory(rows, adjudications) {
  const normalized = checkedRows(rows);
  const evidence = readAdjudicationEvidence(adjudications);
  const settled = settledEvidenceByCase(evidence);
  const holdout = holdoutFamilies(sortedFamilies(normalized));
  const splitRows = normalized
    .map((row) => ({
      entryId: row.entryId,
      cohort: row.cohort,
      familyId: row.familyId,
      familyIdentity: row.familyIdentity,
      familyReason: row.familyReason,
      inputDigest: row.inputDigest,
      labelDigest: row.labelDigest,
      split: row.familyIdentity === 'UNRESOLVED' ? 'UNASSIGNED' : holdout.has(row.familyId) ? 'HOLDOUT' : 'DEVELOPMENT',
      state: row.state,
    }))
    .sort((left, right) => comparePaths(left.entryId, right.entryId));
  /**
   * A row is attributed only by a settled adjudication of the same case that names the row's own
   * source digest, and only when the row also records a label. Anything weaker stays unattributed:
   * a digest with no adjudication, an adjudication of other bytes, or an unsettled review.
   */
  const authenticated = (row) => row.labelDigest !== null && row.inputDigest !== null &&
    settled.get(row.entryId)?.provenance.digest === row.inputDigest;
  const splitCounts = counted(SPLITS, splitRows, 'split');
  const labelledHoldoutCount = splitRows.filter((row) => row.split === 'HOLDOUT' && row.labelDigest !== null).length;
  const authenticatedHoldoutCount = splitRows.filter((row) => row.split === 'HOLDOUT' && authenticated(row)).length;
  const reasons = evidenceReasons(splitCounts, labelledHoldoutCount, authenticatedHoldoutCount);
  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    inventoryDigest: sha256(canonicalJson(splitRows)),
    adjudicationCount: evidence.length,
    adjudicationDigest: adjudicationEvidenceDigest(evidence),
    rows: splitRows,
    splitCounts,
    stateCounts: counted(STATES, splitRows, 'state'),
    cohortCounts: counted(COHORTS, splitRows, 'cohort'),
    familyIdentityCounts: counted(IDENTITIES, splitRows, 'familyIdentity'),
    labelledRowCount: splitRows.filter((row) => row.labelDigest !== null).length,
    labelledHoldoutCount,
    authenticatedRowCount: splitRows.filter(authenticated).length,
    authenticatedHoldoutCount,
    status: reasons.length === 0 ? 'READY' : 'INSUFFICIENT_EVIDENCE',
    reasons,
  };
  return deepFreeze(inventory);
}

function projectedCounts(source, keys, name) {
  exactKeys(source, keys, `evaluation inventory ${name}`);
  const counts = {};
  for (const key of keys) {
    const value = source[key];
    if (!Number.isSafeInteger(value) || value < 0) fail(`evaluation inventory ${name}.${key} is invalid`);
    counts[key] = value;
  }
  return counts;
}

/**
 * The public projection: counts and split status only. Row identities, family
 * IDs and label digests are rebuilt away rather than trusted to stay hidden.
 */
export function publicEvaluationReceipt(inventory) {
  exactKeys(inventory, INVENTORY_KEYS, 'evaluation inventory');
  if (inventory.schemaVersion !== SCHEMA_VERSION) fail('evaluation inventory schemaVersion is not supported');
  if (typeof inventory.inventoryDigest !== 'string' || !DIGEST.test(inventory.inventoryDigest)) fail('evaluation inventory inventoryDigest is invalid');
  if (!Number.isSafeInteger(inventory.adjudicationCount) || inventory.adjudicationCount < 0) fail('evaluation inventory adjudicationCount is invalid');
  if (typeof inventory.adjudicationDigest !== 'string' || !DIGEST.test(inventory.adjudicationDigest)) fail('evaluation inventory adjudicationDigest is invalid');
  const splitCounts = projectedCounts(inventory.splitCounts, SPLITS, 'splitCounts');
  const stateCounts = projectedCounts(inventory.stateCounts, STATES, 'stateCounts');
  const cohortCounts = projectedCounts(inventory.cohortCounts, COHORTS, 'cohortCounts');
  const familyCounts = projectedCounts(inventory.familyIdentityCounts, IDENTITIES, 'familyIdentityCounts');
  const total = Object.values(splitCounts).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || !Array.isArray(inventory.rows) || inventory.rows.length !== total ||
      Object.values(stateCounts).reduce((sum, value) => sum + value, 0) !== total ||
      Object.values(cohortCounts).reduce((sum, value) => sum + value, 0) !== total ||
      familyCounts.UNRESOLVED !== splitCounts.UNASSIGNED || familyCounts.VERIFIED !== splitCounts.DEVELOPMENT + splitCounts.HOLDOUT) {
    fail('evaluation inventory population counts disagree');
  }
  const { labelledRowCount, labelledHoldoutCount, authenticatedRowCount, authenticatedHoldoutCount } = inventory;
  if (!Number.isSafeInteger(labelledRowCount) || labelledRowCount < 0 || labelledRowCount > total ||
      !Number.isSafeInteger(labelledHoldoutCount) || labelledHoldoutCount < 0 ||
      labelledHoldoutCount > splitCounts.HOLDOUT || labelledHoldoutCount > labelledRowCount) {
    fail('evaluation inventory label counts are invalid');
  }
  if (!Number.isSafeInteger(authenticatedRowCount) || authenticatedRowCount < 0 || authenticatedRowCount > labelledRowCount ||
      !Number.isSafeInteger(authenticatedHoldoutCount) || authenticatedHoldoutCount < 0 ||
      authenticatedHoldoutCount > labelledHoldoutCount || authenticatedHoldoutCount > splitCounts.HOLDOUT) {
    fail('evaluation inventory authenticated label counts are invalid');
  }
  const reasons = evidenceReasons(splitCounts, labelledHoldoutCount, authenticatedHoldoutCount);
  const status = reasons.length === 0 ? 'READY' : 'INSUFFICIENT_EVIDENCE';
  if (inventory.status !== status || JSON.stringify(inventory.reasons) !== JSON.stringify(reasons)) fail('evaluation inventory status or reasons disagree with its counts');
  const receipt = {
    schemaVersion: 'evaluation-inventory-public-v3',
    inventoryDigest: inventory.inventoryDigest,
    adjudicationDigest: inventory.adjudicationDigest,
    splitCounts,
    stateCounts,
    cohortCounts,
    labelledRowCount,
    labelledHoldoutCount,
    authenticatedRowCount,
    authenticatedHoldoutCount,
    status,
    reasons,
  };
  return deepFreeze(receipt);
}
