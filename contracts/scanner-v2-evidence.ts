import type { SourceMemberRefV2, SubjectV2 } from './scanner-v2-source';
import type { DiagnosticCodeV2 } from './scanner-v2-diagnostics.generated';

export type AnalysisDiagnosticV2 = {
  id: string;
  code: DiagnosticCodeV2;
  category: 'LIMIT' | 'SOURCE' | 'PARSER' | 'POLICY' | 'GRAPH' | 'CATALOGUE' | 'COMPATIBILITY';
  capabilityId: string;
  aggregateEffect: 'NONE' | 'DEGRADED' | 'INDETERMINATE';
  assessmentEligible: boolean;
  location?: SourceMemberRefV2;
  observed?: number;
  maximum?: number;
  omitted?: number;
};

export type SafeFactScalarV2 = string | number | boolean | null;
export type SafeFactValueV2 = SafeFactScalarV2 | readonly SafeFactScalarV2[];
export type SafeFactV2 = {
  factId: string;
  kind: string;
  subject: SubjectV2;
  properties: Readonly<Record<string, SafeFactValueV2>>;
};

export type TraceStepV2 = {
  ordinal: number;
  kind: 'SOURCE' | 'PROPAGATION' | 'SANITIZER' | 'SINK';
  subject: SubjectV2;
  factRefs: readonly string[];
};
export type TraceV2 = {
  traceId: string;
  kind: 'CONFIDENTIALITY' | 'INTEGRITY' | 'CONTROL';
  steps: readonly TraceStepV2[];
};

export type FindingCandidateV2 = {
  ruleId: string;
  evidenceClass: 'CAPABILITY' | 'CONFIGURATION' | 'SUSPICIOUS_SYNTAX' | 'POTENTIAL_DATAFLOW' | 'VERSION_APPLICABILITY';
  conclusion: 'OBSERVED' | 'POTENTIAL' | 'UNKNOWN';
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNKNOWN';
  subject: SubjectV2;
  factRefs: readonly string[];
  traceRefs: readonly string[];
  remediationId: string;
};
export type FindingV2 = FindingCandidateV2 & {
  findingId: string;
  ruleRevision: string;
  effect: 'SCORING' | 'REPORT_ONLY';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type CapabilityCandidateV2 = {
  findings: readonly FindingCandidateV2[];
  diagnostics: readonly AnalysisDiagnosticV2[];
  facts: readonly SafeFactV2[];
  traces: readonly TraceV2[];
  seen: number;
  analyzed: number;
  skipped: number;
  omitted: number;
};
export type CapabilityExecutionV2 = {
  id: string;
  version: string;
  required: boolean;
  status: 'COMPLETED' | 'SKIPPED' | 'DEGRADED' | 'FAILED';
  seen: number;
  analyzed: number;
  skipped: number;
  omitted: number;
  diagnosticIds: readonly string[];
};
