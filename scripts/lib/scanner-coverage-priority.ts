/**
 * Simulated marginal coverage ranking for Q02.1 (`Q02-COVERAGE.md`). Pure: no clock,
 * randomness, filesystem, network or locale comparison; only canonical requirement
 * encodings leave here. A requirement is `[nodeType, [state, valueOrReason], ...]`, so
 * KNOWN values and UNKNOWN reasons never collide and known-null stays a value. UNKNOWN is
 * valid only in workflow needs, never in admitted or candidate coverage. `unresolvedRemoved`
 * counts distinct encodings removed from eligible missing sets, not overlapping incidence.
 */
import { canonicalizeJson } from '../../packages/scanner-core/src/canonical-json.ts';

export type Known<T> =
  | Readonly<{ state: 'KNOWN'; value: T }>
  | Readonly<{ state: 'UNKNOWN'; reason: string }>;

export type Requirement = Readonly<{
  nodeType: string;
  version: Known<string>;
  resource: Known<string | null>;
  operation: Known<string | null>;
  capability: string;
}>;

export type WorkflowNeeds = Readonly<{
  inputDigest: string;
  requirements: readonly Requirement[];
  eligibility: 'ELIGIBLE' | 'EXCLUDED';
  exclusionReason: string | null;
}>;

export type CandidateScope = Readonly<{
  key: string;
  covers: readonly Requirement[];
  securityInstances: number;
  costUnits: number;
}>;

export type Priority = Readonly<{
  key: string;
  newlyComplete: number;
  unresolvedRemoved: number;
  securityInstances: number;
  costUnits: number;
}>;

const NODE_TYPE_MAX = 512;
const KEY_MAX = 512;
const SCOPE_MAX = 256;
const REASON_MAX = 256;
const MAX_ARRAY_INDEX = 4294967294; // JavaScript array indices are 0..2^32-2.
type CoverageKind = 'candidate' | 'admitted';

type EncodedCandidate = Readonly<{
  key: string;
  coverage: ReadonlySet<string>;
  securityInstances: number;
  costUnits: number;
}>;

type TrackedWorkflow = Readonly<{ digest: string; missing: Set<string> }>;

function reject(reason: string): never {
  throw new TypeError(`scanner-coverage-priority: ${reason}`);
}

function checkString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') reject(`${label} must be a string`);
  if (value.length === 0) reject(`${label} must not be empty`);
  if (value.length > maxLength) reject(`${label} exceeds ${maxLength} UTF-16 code units`);
  if (value.normalize('NFC') !== value) reject(`${label} must be NFC-normalized`);
  return value;
}

function checkCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    reject(`${label} must be a non-negative integer`);
  }
  return value;
}

function encodeDimension(
  known: unknown,
  label: string,
  nullable: boolean,
  coverage: CoverageKind | null,
): readonly [string, string | null] {
  if (typeof known !== 'object' || known === null) reject(`${label} must be a KNOWN or UNKNOWN value`);
  const record = known as Readonly<{ state?: unknown; value?: unknown; reason?: unknown }>;
  if (record.state === 'UNKNOWN') {
    if (coverage !== null) reject(`UNKNOWN is not valid ${coverage} coverage (${label})`);
    return ['UNKNOWN', checkString(record.reason, `${label}.reason`, REASON_MAX)];
  }
  if (record.state !== 'KNOWN') reject(`${label}.state must be KNOWN or UNKNOWN`);
  if (record.value === null) {
    if (!nullable) reject(`${label} does not accept null`);
    return ['KNOWN', null];
  }
  return ['KNOWN', checkString(record.value, `${label}.value`, SCOPE_MAX)];
}

function encodeRequirement(
  requirement: Requirement,
  label: string,
  coverage: CoverageKind | null,
): string {
  if (typeof requirement !== 'object' || requirement === null) reject(`${label} must be an object`);
  return canonicalizeJson([
    checkString(requirement.nodeType, `${label}.nodeType`, NODE_TYPE_MAX),
    encodeDimension(requirement.version, `${label}.version`, false, coverage),
    encodeDimension(requirement.resource, `${label}.resource`, true, coverage),
    encodeDimension(requirement.operation, `${label}.operation`, true, coverage),
    checkString(requirement.capability, `${label}.capability`, NODE_TYPE_MAX),
  ]);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Reject holes and non-index properties so neither forEach nor map can skip an entry. */
function assertDenseArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) reject(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) reject(`${label} must not contain holes`);
  }
  for (const key of Object.keys(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) > MAX_ARRAY_INDEX) reject(`${label} must not carry non-index properties`);
  }
}

/** Dedupe requirement encodings and order them by code unit; order is never locale-derived. */
function encodeCoverage(
  requirements: readonly Requirement[],
  label: string,
  coverage: CoverageKind | null,
): ReadonlySet<string> {
  assertDenseArray(requirements, label);
  const encodings = new Set(
    requirements.map((requirement, index) => encodeRequirement(requirement, `${label}[${index}]`, coverage)),
  );
  return new Set([...encodings].sort(compareCodeUnits));
}

/** Rank, then cost, then key; every dimension is compared explicitly so no locale leaks in. */
function ranksAbove(candidate: Priority, incumbent: Priority): boolean {
  if (candidate.newlyComplete !== incumbent.newlyComplete) return candidate.newlyComplete > incumbent.newlyComplete;
  if (candidate.securityInstances !== incumbent.securityInstances) return candidate.securityInstances > incumbent.securityInstances;
  if (candidate.unresolvedRemoved !== incumbent.unresolvedRemoved) return candidate.unresolvedRemoved > incumbent.unresolvedRemoved;
  if (candidate.costUnits !== incumbent.costUnits) return candidate.costUnits < incumbent.costUnits;
  return compareCodeUnits(candidate.key, incumbent.key) < 0;
}

/** Marginal score of one candidate against the current missing sets. */
function evaluate(candidate: EncodedCandidate, workflows: readonly TrackedWorkflow[]): Priority {
  const removed = new Set<string>();
  let newlyComplete = 0;
  for (const workflow of workflows) {
    if (workflow.missing.size === 0) continue;
    let covered = 0;
    for (const requirement of workflow.missing) {
      if (!candidate.coverage.has(requirement)) continue;
      covered += 1;
      removed.add(requirement);
    }
    if (covered === workflow.missing.size) newlyComplete += 1;
  }
  return {
    key: candidate.key,
    newlyComplete,
    unresolvedRemoved: removed.size,
    securityInstances: candidate.securityInstances,
    costUnits: candidate.costUnits,
  };
}

export function rankCoverage(
  needs: readonly WorkflowNeeds[],
  admitted: readonly Requirement[],
  candidates: readonly CandidateScope[],
): readonly Priority[] {
  assertDenseArray(needs, 'needs');
  assertDenseArray(admitted, 'admitted');
  assertDenseArray(candidates, 'candidates');

  const admittedCoverage = encodeCoverage(admitted, 'admitted', 'admitted');

  const digests = new Set<string>();
  const workflows: TrackedWorkflow[] = [];
  needs.forEach((row, index) => {
    if (typeof row !== 'object' || row === null) reject(`needs[${index}] must be an object`);
    const digest = checkString(row.inputDigest, `needs[${index}].inputDigest`, KEY_MAX);
    if (digests.has(digest)) reject(`duplicate workflow inputDigest at needs[${index}]`);
    digests.add(digest);
    if (row.eligibility === 'ELIGIBLE') {
      if (row.exclusionReason !== null) {
        reject(`eligible workflow at needs[${index}] must have a null exclusionReason`);
      }
    } else if (row.eligibility === 'EXCLUDED') {
      checkString(row.exclusionReason, `needs[${index}].exclusionReason`, REASON_MAX);
    } else {
      reject(`needs[${index}].eligibility must be ELIGIBLE or EXCLUDED`);
    }

    const encodings = encodeCoverage(row.requirements, `needs[${index}].requirements`, null);
    if (row.eligibility !== 'ELIGIBLE') return;
    const missing = new Set<string>();
    for (const encoding of encodings) {
      if (!admittedCoverage.has(encoding)) missing.add(encoding);
    }
    workflows.push({ digest, missing });
  });
  workflows.sort((left, right) => compareCodeUnits(left.digest, right.digest));

  const keys = new Set<string>();
  const remaining: EncodedCandidate[] = candidates.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) {
      reject(`candidates[${index}] must be an object`);
    }
    const key = checkString(candidate.key, `candidates[${index}].key`, KEY_MAX);
    if (keys.has(key)) reject(`duplicate candidate key at candidates[${index}]`);
    keys.add(key);
    const coverage = encodeCoverage(candidate.covers, `candidates[${index}].covers`, 'candidate');
    return {
      key,
      coverage,
      securityInstances: checkCount(candidate.securityInstances, `candidates[${index}].securityInstances`),
      costUnits: checkCount(candidate.costUnits, `candidates[${index}].costUnits`),
    };
  });
  remaining.sort((left, right) => compareCodeUnits(left.key, right.key));

  const ranked: Priority[] = [];
  while (remaining.length > 0) {
    let chosenIndex = 0;
    let chosenPriority = evaluate(remaining[0], workflows);
    for (let index = 1; index < remaining.length; index += 1) {
      const priority = evaluate(remaining[index], workflows);
      if (ranksAbove(priority, chosenPriority)) {
        chosenIndex = index;
        chosenPriority = priority;
      }
    }
    const [chosen] = remaining.splice(chosenIndex, 1);
    for (const workflow of workflows) {
      for (const requirement of chosen.coverage) workflow.missing.delete(requirement);
    }
    ranked.push(Object.freeze(chosenPriority));
  }
  return Object.freeze(ranked);
}
