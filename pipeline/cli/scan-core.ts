import {
  DEFAULT_SCANNER_LIMITS,
  SCANNER_RESULT_SCHEMA_VERSION,
  toWorkflowParseOptions,
} from '@hub/contracts';
import { createHumanReadableScanSummary, type HumanReadableScanSummary } from '@hub/scanner-core/human-summary';
import { redactScanPresentation } from '@hub/scanner-core/presentation-redaction';
import { asRequiredStageFailure, classifyAnalysisStatus } from '@hub/scanner-core/result/analysis-completeness';
import { attachFindingSourceSpans } from '@hub/scanner-core/result/finding-source-spans';
import {
  analyzeWorkflowInsights,
  type WorkflowFunctionSummary,
  type WorkflowOverview,
} from '@hub/scanner-core/scan-insights';
import type { CanonicalScanFinding } from '@hub/scanner-core/policy';
import { parseWorkflowJson, type NormalizedWorkflow, type WorkflowParseErrorCode } from '@hub/scanner-core/workflow';
import type { WorkflowIntegration } from '@hub/scanner-core/workflow-insights';
import { scanWorkflowWithCore, type ScannerCoreAdapterResult } from '../scan/scanner-core-adapter.js';
import type { ScanProfile } from './cli-contract.js';

export type CliScanFailure = {
  ok: false;
  kind: 'input' | 'internal';
  code: WorkflowParseErrorCode | 'INTERNAL';
  message: string;
};

export type CliScanSuccess = { ok: true; result: CliScanResult };
export type CliScanOutcome = CliScanSuccess | CliScanFailure;

export type ScanCoreOptions = {
  profile: ScanProfile;
  approvedDomains: string[];
};

export type CliScanResult = Omit<ScannerCoreAdapterResult, 'findings'> & {
  workflow: WorkflowOverview;
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowIntegration[];
  findings: CanonicalScanFinding[];
  humanSummary?: HumanReadableScanSummary;
};

/** Transport-free CLI boundary over the same deterministic scanner contract as the browser worker. */
export function scanJson(json: string, options: ScanCoreOptions): CliScanOutcome {
  try {
    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    if (!parsed.ok) return { ok: false, kind: 'input', code: parsed.code, message: parsed.message };

    const core = scanWorkflowWithCore(parsed.workflow, {
      policyProfile: options.profile,
      ...(options.approvedDomains.length > 0 ? { approvedDomains: options.approvedDomains } : {}),
    });
    const attached = options.profile === 'beta-hardened'
      ? attachFindingSourceSpans(core.findings, parsed.workflow.nodes)
      : { findings: core.findings, unresolvedCount: 0 };
    const diagnostics = [...core.analysisDiagnostics];
    if (attached.unresolvedCount > 0) diagnostics.push({ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' });
    const analysisDiagnostics = diagnostics.map(asRequiredStageFailure);
    const analysisStatus = classifyAnalysisStatus(analysisDiagnostics);
    const insights = buildInsights(parsed.workflow);
    let result: CliScanResult;

    if (analysisStatus === 'INDETERMINATE') {
      result = {
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        scannerVersion: core.scannerVersion,
        policyProfile: core.policyProfile,
        analysisStatus,
        analysisDiagnostics,
        ...insights,
        findings: attached.findings,
      };
    } else {
      if (!core.riskAssessment || !core.summary) {
        return { ok: false, kind: 'internal', code: 'INTERNAL', message: 'Scanner returned an incomplete assessment.' };
      }
      result = {
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        scannerVersion: core.scannerVersion,
        policyProfile: core.policyProfile,
        analysisStatus,
        analysisDiagnostics,
        ...insights,
        findings: attached.findings,
        riskAssessment: core.riskAssessment,
        humanSummary: createHumanReadableScanSummary({
          ...insights,
          riskAssessment: core.riskAssessment,
          summary: core.summary,
          findings: attached.findings,
        }),
        summary: core.summary,
      };
    }

    if (result.schemaVersion !== SCANNER_RESULT_SCHEMA_VERSION) {
      return { ok: false, kind: 'internal', code: 'INTERNAL', message: 'Scanner returned an unsupported result schema.' };
    }
    return { ok: true, result: redactScanPresentation(result) };
  } catch {
    return { ok: false, kind: 'internal', code: 'INTERNAL', message: 'Scanner failed while analyzing the workflow.' };
  }
}

function buildInsights(workflow: NormalizedWorkflow) {
  return analyzeWorkflowInsights(workflow);
}
