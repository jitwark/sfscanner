import {
  ADVISORY_EVALUATION_V1, 
  ADVISORY_PACKAGE_COVERAGE_V1, ADVISORY_EVALUATION_STATES_V1,
} from '@hub/contracts/scanner-v2-advisory';
import type { SafeFactV2 } from '../capabilities/scheduler';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { canonicalSafeFactProperties, validateSafeFact } from '../facts/safe-fact-validator';
import { createSafeFactAdmissionSnapshotV2 } from '../admission/snapshot';
import { makeFact } from '../capabilities/adapter-evidence';
import type { TargetContextV3 } from '../semantics/target-context';

export type AdvisoryInventoryStateV3 = 'DECLARED' | 'UNVERIFIED';
export type AdvisoryRequestV3 = Readonly<{ requested: boolean; inventoryState: AdvisoryInventoryStateV3 }>;
type EvaluationState = (typeof ADVISORY_EVALUATION_STATES_V1)[number];
type Pair = Readonly<{ packageName: string; packageVersion: string | null }>;


const WORKFLOW = Object.freeze({ kind: 'WORKFLOW' as const });
const NULL_IDENTITY = Object.freeze({
  sourceId: null, pinDigest: null, coverageDigest: null, rightsReceiptDigest: null,
  provenanceReceiptDigest: null, boundsDigest: null, admissionReceiptDigest: null,
  pinnedSnapshotSha256: null, snapshotSha256: null, capturedAt: null, admittedAt: null,
  evaluatedAt: null, catalogueVersion: null, catalogueDigest: null,
});

function pairs(target: TargetContextV3): readonly Pair[] {
  return target.communityPackages.map(({ name, version }) => Object.freeze({ packageName: name, packageVersion: version ?? null }));
}
export function createAdvisoryFactV1(kind: string, properties: Record<string, string | number | boolean | null | readonly string[]>): SafeFactV2 {
  const canonical = canonicalSafeFactProperties(kind, properties);
  if (canonical === undefined) throw new TypeError('Invalid canonical advisory fact');
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((item) => item.kind === kind);
  if (schema === undefined) throw new TypeError('Unknown canonical advisory kind');
  const admitted = validateSafeFact(createSafeFactAdmissionSnapshotV2(makeFact(kind, WORKFLOW, canonical)), schema, DEFAULT_SCANNER_LIMITS_V2);
  if (!admitted.ok) throw new TypeError('Invalid canonical advisory fact');
  return admitted.fact;
}
function evaluation(target: TargetContextV3, state: EvaluationState, reason: string | null, base: Record<string, unknown>): SafeFactV2 {
  return createAdvisoryFactV1(ADVISORY_EVALUATION_V1, {
    evaluationState: state, evaluationReason: reason, targetDigest: target.contextDigest,
    ...NULL_IDENTITY,
    coverageClaimed: false, packagesRequested: 0, packagesCovered: 0, packageRowsOmitted: 0,
    recordsExamined: 0, recordsApplicable: 0, recordsNotApplicable: 0, recordsUnknown: 0,
    omissionReasons: [], ...base,
  });
}
function coverage(pair: Pair, reason: 'SNAPSHOT_UNAVAILABLE' | 'VERSION_MISSING' | 'INVENTORY_UNVERIFIED'): SafeFactV2 {
  return createAdvisoryFactV1(ADVISORY_PACKAGE_COVERAGE_V1, {
    packageName: pair.packageName, packageVersion: pair.packageVersion,
    coverageState: 'UNKNOWN', coverageReason: reason,
  });
}

/** Production path: request metadata only. No caller-supplied record or authority survives this seam. */
export function buildAdvisoryFactsV1(input: Readonly<{ target: TargetContextV3; request?: AdvisoryRequestV3 }>): readonly SafeFactV2[] {
  const request = input.request;
  if (request === undefined || request.requested === false || request.inventoryState === 'DECLARED' && input.target.communityPackages.length === 0) {
    const state: EvaluationState = request === undefined || request.requested === false ? 'NOT_REQUESTED' : 'NO_DECLARED_PACKAGES';
    return Object.freeze([evaluation(input.target, state, 'NONE', {})]);
  }
  if (request.inventoryState === 'UNVERIFIED') return Object.freeze([evaluation(input.target, 'REFUSED', 'INVENTORY_UNVERIFIED', {})]);
  const declared = pairs(input.target);
  return Object.freeze([
    evaluation(input.target, 'UNAVAILABLE', 'NO_ADMITTED_SNAPSHOT', { packagesRequested: declared.length }),
    ...declared.map((pair) => coverage(pair, 'SNAPSHOT_UNAVAILABLE')),
  ]);
}

