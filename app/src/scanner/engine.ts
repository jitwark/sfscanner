import { SCANNER_RESULT_SCHEMA_VERSION, type ScannerResultIdentity } from '@hub/contracts';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import { resolvePolicyProfile, type PolicyProfileId } from '@hub/scanner-core/policies/profile';
import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { asRequiredStageFailure, classifyAnalysisStatus } from '@hub/scanner-core/result/analysis-completeness';
import { attachFindingSourceSpans } from '@hub/scanner-core/result/finding-source-spans';
import { collectAmbiguousNodeIds } from './node-identity';
import { redactScanPresentation } from '@hub/scanner-core/presentation-redaction';
import { scanWithScannerCore } from './scanner-core-adapter';
import {
  createHumanReadableScanSummary,
  type HumanReadableScanSummary,
} from './human-summary';
import type {
  AnalysisDiagnostic,
  AnalysisStatus,
  CanonicalScanFinding,
  ScanPolicy,
  ScanSummary,
} from '@hub/scanner-core/policy';
import {
  analyzeWorkflowInsights,
  assessWorkflowRisk,
  type WorkflowFunctionSummary,
  type WorkflowIntegration,
  type WorkflowOverview,
  type WorkflowRiskAssessment,
} from './workflow-insights';

/**
 * Hardened analyzer findings are additionally capped per scan. Each analyzed
 * source is capped at ten by the analyzers themselves; this bounds a workflow
 * that spreads many findings across many nodes. Either cap firing emits
 * `ANALYSIS_LIMIT_EXCEEDED` so truncation is never presented as complete.
 */
export const MAX_HARDENED_FINDINGS_PER_SCAN = 100;

export type ScanWorkflowOptions = {
  approvedDomains?: string[];
  policyFactory?: (options: ScanWorkflowOptions) => ScanPolicy[];
  policyProfile?: PolicyProfileId;
};

export type ScanWorkflowResult = ScannerResultIdentity & {
  scannerVersion: typeof SCANNER_VERSION;
  policyProfile: PolicyProfileId;
  analysisStatus: AnalysisStatus;
  analysisDiagnostics: AnalysisDiagnostic[];
  workflow: WorkflowOverview;
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowIntegration[];
  findings: CanonicalScanFinding[];
  /**
   * Present only when `analysisStatus !== 'INDETERMINATE'`. A required stage (a crashed scoring
   * policy, unreadable node parameters, an analyzer that could not read or parse a unit) means
   * these would read as a completed, reassuring verdict over incomplete evidence.
   */
  riskAssessment?: WorkflowRiskAssessment;
  humanSummary?: HumanReadableScanSummary;
  summary?: ScanSummary;
};

export function scanWorkflow(
  workflow: NormalizedWorkflow,
  options: ScanWorkflowOptions = {},
): ScanWorkflowResult {
  const profile = resolvePolicyProfile(options.policyProfile ?? 'beta-default');
  if (!profile.ok) {
    throw new Error(`Unknown scanner profile: ${profile.profileId}`);
  }
  const coreResult = scanWithScannerCore(workflow, {
    profileId: profile.profileId,
    approvedDomains: options.approvedDomains,
    policies: options.policyFactory?.(options),
    maxAnalyzerFindings: MAX_HARDENED_FINDINGS_PER_SCAN,
    ambiguousNodeIds: workflow.parseDiagnostics.some((diagnostic) => diagnostic.code === 'DUPLICATE_NODE_ID')
      ? collectAmbiguousNodeIds(workflow.nodes)
      : new Set<string>(),
  });
  const spanAttachment = profile.includesSourceSpans
    ? attachFindingSourceSpans(
      coreResult.findings as unknown as CanonicalScanFinding[],
      workflow.nodes,
    )
    : {
      findings: coreResult.findings as unknown as CanonicalScanFinding[],
      unresolvedCount: 0,
    };
  const findings = spanAttachment.findings;
  const diagnostics = spanAttachment.unresolvedCount > 0
    ? [
      ...coreResult.diagnostics,
      { code: 'SOURCE_SPAN_UNAVAILABLE' as const, category: 'SOURCE' as const },
    ]
    : coreResult.diagnostics;
  const analysisDiagnostics = diagnostics.map(asRequiredStageFailure);
  const insights = analyzeWorkflowInsights(workflow);
  const summary = coreResult.summary;
  const riskAssessment = assessWorkflowRisk(
    workflow,
    findings.filter((finding) => finding.policyEffect !== 'REPORT_ONLY'),
    insights,
  );
  const analysisStatus = classifyAnalysisStatus(analysisDiagnostics);

  // The ladder above already turned a failed stage into its explicit INDETERMINATE-class
  // diagnostic, so the derived status carries failure-vs-omission: a required stage that
  // produced no usable assessment suppresses the grade below, while a cosmetic omission or an
  // analyzer cap degrades the scan and still reports the grade.
  const completedFields = analysisStatus === 'INDETERMINATE'
    ? {}
    : {
      riskAssessment,
      humanSummary: createHumanReadableScanSummary({ ...insights, riskAssessment, summary, findings }),
      summary,
    };

  return redactScanPresentation({
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: profile.version,
    policyProfile: profile.profileId,
    analysisStatus,
    analysisDiagnostics,
    ...insights,
    findings,
    ...completedFields,
  });
}
