import { SCANNER_RESULT_SCHEMA_VERSION, type PublicFinding, type Severity } from '@hub/contracts';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import {
  analyzeAiCapabilities,
} from '@hub/scanner-core/analyzers/ai/ai-capability-analysis';
import { analyzeWorkflowJavaScript } from '@hub/scanner-core/analyzers/code/javascript-analysis';
import { analyzeWorkflowPython } from '@hub/scanner-core/analyzers/code/python-analysis';
import { analyzeWorkflowTaint } from '@hub/scanner-core/analyzers/taint/taint-analysis';
import { scanWorkflowCore, type CoreAnalyzer } from '@hub/scanner-core/engine';
import { analyzeWorkflowInsights } from '@hub/scanner-core/scan-insights';
import { assessWorkflowRisk } from '@hub/scanner-core/scan-risk';
import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { resolvePolicyProfile, type PolicyProfileId } from '@hub/scanner-core/policies/profile';
import type {
  AnalysisDiagnostic,
  AnalysisStatus,
  CanonicalScanFinding,
  ScanSummary,
} from '@hub/scanner-core/policy';

const MAX_HARDENED_FINDINGS_PER_SCAN = 100;

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/** Compatibility name retained for pipeline callers; identity belongs to scanner-core. */
export function getScannerVersion(): typeof SCANNER_VERSION { return SCANNER_VERSION; }

export function projectFinding(finding: Record<string, unknown>): PublicFinding {
  const id = String(finding.policyId ?? finding.id ?? 'UNKNOWN');
  const severity = typeof finding.severity === 'string' && finding.severity in SEVERITY_ORDER
    ? finding.severity as Severity : 'INFO';
  const location = (finding.location && typeof finding.location === 'object' ? finding.location : {}) as Record<string, unknown>;
  const nodeName = location.nodeName ?? location.nodeId ?? finding.node;
  return {
    id, title: String(finding.title ?? ''), severity,
    ...(typeof nodeName === 'string' && nodeName.trim() ? { node: nodeName } : {}),
    why: String(finding.whyItMatters ?? finding.why ?? finding.message ?? ''),
    fix: String(finding.remediation ?? finding.fix ?? ''),
  };
}

export function sortFindings(findings: PublicFinding[]): PublicFinding[] {
  return [...findings].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || compareCanonicalStrings(left.id, right.id));
}

export type ScannerCoreAdapterOptions = {
  policyProfile?: PolicyProfileId;
  approvedDomains?: readonly string[];
  maxAnalyzerFindings?: number;
};

export type ScannerCoreAdapterResult = {
  schemaVersion: typeof SCANNER_RESULT_SCHEMA_VERSION;
  scannerVersion: typeof SCANNER_VERSION;
  policyProfile: PolicyProfileId;
  analysisStatus: AnalysisStatus;
  analysisDiagnostics: AnalysisDiagnostic[];
  findings: CanonicalScanFinding[];
  riskAssessment?: {
    score: number;
    grade: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    topRisks: string[];
    dataExposure: string;
    complexityDrivers: string[];
  };
  summary?: ScanSummary;
};

export function scanWorkflowWithCore(
  workflow: NormalizedWorkflow,
  options: ScannerCoreAdapterOptions = {},
): ScannerCoreAdapterResult {
  const profile = resolvePolicyProfile(options.policyProfile ?? 'beta-default');
  if (!profile.ok) throw new Error(`Unknown scanner profile: ${profile.profileId}`);

  const core = scanWorkflowCore(workflow, {
    policies: profile.createPolicies({ approvedDomains: options.approvedDomains }),
    analyzers: createAnalyzers(profile.includesJavaScriptAnalysis, profile.includesPythonAnalysis, profile.includesTaintAnalysis),
    ruleCatalog: profile.ruleCatalog,
    maxAnalyzerFindings: options.maxAnalyzerFindings ?? MAX_HARDENED_FINDINGS_PER_SCAN,
    ambiguousNodeIds: duplicateNodeIds(workflow),
  });
  const result: ScannerCoreAdapterResult = {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: profile.version,
    policyProfile: profile.profileId,
    analysisStatus: core.analysisStatus,
    analysisDiagnostics: core.diagnostics,
    findings: core.findings,
  };
  if (core.analysisStatus !== 'INDETERMINATE') {
    result.riskAssessment = assessWorkflowRisk(
      workflow,
      core.findings,
      analyzeWorkflowInsights(workflow),
    );
    result.summary = core.summary;
  }
  return result;
}

function createAnalyzers(
  javascript: boolean,
  python: boolean,
  taint: boolean,
): readonly CoreAnalyzer[] {
  if (!javascript && !python && !taint) return [];
  return [
    (workflow) => {
      const js = javascript ? analyzeWorkflowJavaScript(workflow) : { findings: [], diagnostics: [] };
      const py = python ? analyzeWorkflowPython(workflow) : { findings: [], diagnostics: [] };
      const taintResult = taint ? analyzeWorkflowTaint(workflow) : { findings: [], diagnostics: [] };
      const ai = taintResult.propagation
        ? analyzeAiCapabilities(workflow, taintResult.propagation)
        : { findings: [], diagnostics: [] };
      return {
        findings: [...js.findings, ...py.findings, ...taintResult.findings, ...ai.findings],
        diagnostics: [...js.diagnostics, ...py.diagnostics, ...taintResult.diagnostics, ...ai.diagnostics],
      };
    },
  ];
}

function duplicateNodeIds(workflow: NormalizedWorkflow): ReadonlySet<string> {
  const indexes = workflow.parseDiagnostics
    .filter((diagnostic) => diagnostic.code === 'DUPLICATE_NODE_ID')
    .flatMap((diagnostic) => diagnostic.nodeIndexes);
  return new Set(indexes.map((index) => workflow.nodes[index]?.id).filter((id): id is string => id !== undefined));
}
