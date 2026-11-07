import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import type { AnalysisStatus, PolicyEffect, ScanSeverity } from '@hub/scanner-core/policy';
import type { WorkflowParseErrorCode } from '@hub/scanner-core/workflow';
import type { ScanProfile } from '../cli/cli-contract.js';

export type CalibrationSplit = 'development' | 'holdout';
export type CalibrationStratum =
  | 'clean-negative' | 'legacy-policy' | 'credential' | 'network'
  | 'hardened-code' | 'hardened-taint' | 'ai-autonomy' | 'completeness'
  | 'resource-adversarial' | 'input-adversarial' | 'analyzer-adversarial';
export type CalibrationTheme =
  | 'clean-controls' | 'legacy-capability' | 'credential-shape'
  | 'domain-allowlist' | 'hardened-code' | 'hardened-taint'
  | 'ai-control' | 'completeness-boundary' | 'resource-boundary'
  | 'input-boundary' | 'analyzer-boundary';
export type CalibrationExpectedStatus = 'ACCEPTED' | 'REJECTED';
export type CalibrationObservedStatus = CalibrationExpectedStatus;

export type CalibrationExpectedFinding = {
  policyId: string;
  effect: PolicyEffect;
  severities: readonly ScanSeverity[];
};

export type CalibrationCase = {
  id: string;
  workflowJson: string;
  canonicalFixture: unknown;
  canonicalFixtureHash: string;
  profile: ScanProfile;
  approvedDomains: readonly string[];
  split: CalibrationSplit;
  stratum: CalibrationStratum;
  confusionTheme: CalibrationTheme;
  expectedFindings: readonly CalibrationExpectedFinding[];
  expectedStatus: CalibrationExpectedStatus;
  expectedCompleteness: AnalysisStatus | 'NOT_APPLICABLE';
  expectedRejectionCode?: WorkflowParseErrorCode;
  allowedEvidenceNotes: readonly string[];
  reviewer: string;
  reviewDate: string;
  rationale: string;
  falseNegativeProbe?: boolean;
};

export type ObservedFindingIdentity = {
  policyId: string;
  effect: PolicyEffect;
  severities: readonly ScanSeverity[];
};

export type CalibrationCaseResult = {
  caseId: string;
  split: CalibrationSplit;
  stratum: CalibrationStratum;
  confusionTheme: CalibrationTheme;
  status: CalibrationObservedStatus;
  completeness: AnalysisStatus | 'NOT_APPLICABLE';
  expectedPolicyIds: readonly string[];
  observedPolicyIds: readonly string[];
  observedFindings: readonly ObservedFindingIdentity[];
  truePositivePolicies: readonly string[];
  falsePositivePolicies: readonly string[];
  falseNegativePolicies: readonly string[];
  identityMismatches: readonly string[];
  grade: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'NOT_GRADED';
  durationMs: number;
  errorCode?: string;
};

export type CalibrationPolicyMetric = {
  expectedCases: number;
  observedCases: number;
  truePositiveCases: number;
  falsePositiveCases: number;
  falseNegativeCases: number;
  precision: number | null;
  recall: number | null;
};

export type CalibrationThemeMetric = {
  theme: CalibrationTheme;
  caseIds: readonly string[];
  caseCount: number;
  expectedPolicyCount: number;
  observedPolicyCount: number;
  agreementCases: number;
  falsePositiveCases: number;
  falseNegativeCases: number;
};

export type CalibrationReport = {
  schemaVersion: 'calibration-report-v1';
  scannerVersion: typeof SCANNER_VERSION;
  caseCount: number;
  splitCounts: Record<CalibrationSplit, number>;
  metrics: Record<string, CalibrationPolicyMetric>;
  confusionThemes: readonly CalibrationThemeMetric[];
  falseNegativeProbeIds: readonly string[];
  observedFalseNegativeCaseIds: readonly string[];
  gradeHistogram: Record<CalibrationCaseResult['grade'], number>;
  statusHistogram: Record<AnalysisStatus | 'REJECTED', number>;
  runtime: {
    deviceProfile: string;
    sampleCount: number;
    totalMs: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  cases: readonly CalibrationCaseResult[];
};

export type CalibrationRunOptions = {
  now?: () => number;
  deviceProfile?: string;
};

export function canonicalFixtureHash(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(value))));
}
