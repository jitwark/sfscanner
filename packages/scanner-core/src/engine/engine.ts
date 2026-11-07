import type { NormalizedWorkflow } from '../workflow';
import {
  canonicalizeFindings,
  type CanonicalFindingsResult,
} from '../result/canonical-findings';
import { asRequiredStageFailure, classifyAnalysisStatus } from '../result/analysis-completeness';
import { collectAnalysisDiagnostics } from '../result/analysis-diagnostics-collection';
import type {
  AnalysisDiagnostic,
  AnalysisStatus,
  CanonicalScanFinding,
  ScanFinding,
  ScanPolicy,
  ScanSummary,
} from '../policy/policy';
import type { RuleCatalogEntry } from '../policy/rule-catalog';
import { scanCapabilitiesV2 as scanCapabilitiesAdapter } from '../capabilities/beta-default';
import type { AnalyzerContextV2, CapabilityScheduleV2 } from '../capabilities/scheduler';
import { resolvePolicyProfile, type PolicyProfileResult } from '../policies/profile';

export type ScanCapabilitiesV2Failure =
  | { ok: false; code: 'UNKNOWN_PROFILE'; profileId: string }
  | { ok: false; code: 'PROFILE_NOT_ADMITTED'; profileId: string };

export type ScanCapabilitiesV2Result = CapabilityScheduleV2 | ScanCapabilitiesV2Failure;

export function scanCapabilitiesV2(
  context: AnalyzerContextV2,
  profile: PolicyProfileResult,
): ScanCapabilitiesV2Result {
  if (!profile || !profile.ok) return profile;

  const canonical = resolvePolicyProfile(profile.profileId);
  if (!canonical.ok) return canonical;
  if (canonical !== profile) {
    return { ok: false, code: 'PROFILE_NOT_ADMITTED', profileId: profile.profileId };
  }
  if (canonical.capabilityManifest === null || typeof canonical.createCapabilityRegistry !== 'function') {
    return { ok: false, code: 'PROFILE_NOT_ADMITTED', profileId: canonical.profileId };
  }

  try {
    return scanCapabilitiesAdapter(
      context,
      canonical.capabilityManifest,
      canonical.createCapabilityRegistry(),
    );
  } catch {
    return { ok: false, code: 'PROFILE_NOT_ADMITTED', profileId: canonical.profileId };
  }
}

export type CoreAnalyzerResult = {
  findings: readonly ScanFinding[];
  diagnostics: readonly AnalysisDiagnostic[];
};

export type CoreAnalyzer = (workflow: NormalizedWorkflow) => CoreAnalyzerResult;

export type ScanWorkflowCoreOptions = {
  policies: readonly ScanPolicy[];
  analyzers?: readonly CoreAnalyzer[];
  ruleCatalog: readonly RuleCatalogEntry[];
  maxAnalyzerFindings?: number;
  ambiguousNodeIds?: ReadonlySet<string>;
};

export type ScanWorkflowCoreResult = {
  findings: CanonicalScanFinding[];
  diagnostics: AnalysisDiagnostic[];
  analysisStatus: AnalysisStatus;
  summary: ScanSummary;
  policyFailureCount: number;
  rejectedCount: number;
  collapsedCount: number;
};

export function scanWorkflowCore(
  workflow: NormalizedWorkflow,
  options: ScanWorkflowCoreOptions,
): ScanWorkflowCoreResult {
  const policyEvaluation = evaluatePolicies(options.policies, workflow);
  const analyzerFindings: ScanFinding[] = [];
  const analyzerDiagnostics: AnalysisDiagnostic[] = [];

  for (const analyzer of options.analyzers ?? []) {
    const result = analyzer(workflow);
    analyzerFindings.push(...result.findings);
    analyzerDiagnostics.push(...result.diagnostics.map(asRequiredStageFailure));
  }

  const maxAnalyzerFindings = Math.max(0, options.maxAnalyzerFindings ?? Number.POSITIVE_INFINITY);
  const canonical = canonicalizeFindings(
    [...policyEvaluation.findings, ...analyzerFindings],
    options.ruleCatalog,
    {
      legacyFindingCount: policyEvaluation.findings.length,
      maxAnalyzerFindings,
      ambiguousNodeIds: options.ambiguousNodeIds,
    },
  );
  const diagnostics = collectAnalysisDiagnostics({
    workflow,
    analyzerDiagnostics,
    spanUnresolvedCount: 0,
    policyRejectedCount: canonical.rejectedCount,
    policyFailedCount: policyEvaluation.failureCount,
    findingCollapsedCount: canonical.collapsedCount,
    scanCapExceeded: analyzerFindings.length > maxAnalyzerFindings,
  });

  return {
    findings: canonical.findings,
    diagnostics,
    analysisStatus: classifyAnalysisStatus(diagnostics),
    summary: summarizeFindings(canonical),
    policyFailureCount: policyEvaluation.failureCount,
    rejectedCount: canonical.rejectedCount,
    collapsedCount: canonical.collapsedCount,
  };
}

function evaluatePolicies(
  policies: readonly ScanPolicy[],
  workflow: NormalizedWorkflow,
): { findings: ScanFinding[]; failureCount: number } {
  const findings: ScanFinding[] = [];
  let failureCount = 0;
  for (const policy of policies) {
    try {
      findings.push(...policy.evaluate(workflow));
    } catch {
      failureCount += 1;
    }
  }
  return { findings, failureCount };
}

function summarizeFindings(canonical: CanonicalFindingsResult): ScanSummary {
  const summary: ScanSummary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of canonical.findings) {
    const key = finding.severity.toLowerCase() as keyof ScanSummary;
    summary[key] += 1;
  }
  return summary;
}
