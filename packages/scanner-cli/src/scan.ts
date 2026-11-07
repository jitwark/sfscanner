import {
  DEFAULT_SCANNER_LIMITS,
  SCANNER_RESULT_SCHEMA_VERSION,
  toWorkflowParseOptions,
} from '@hub/contracts';
import { scanWorkflowCore } from '@hub/scanner-core/engine';
import { redactScanPresentation } from '@hub/scanner-core/presentation-redaction';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import type { AnalysisDiagnostic, CanonicalScanFinding, ScanSummary } from '@hub/scanner-core/policy';
import { resolvePolicyProfile } from '@hub/scanner-core/policies/profile';
import { attachFindingSourceSpans } from '@hub/scanner-core/result/finding-source-spans';
import { parseWorkflowJson, type WorkflowParseErrorCode } from '@hub/scanner-core/workflow';

export const CLI_SCHEMA_VERSION = 'n8n-scan-v1' as const;
export const CLI_VERSION = '0.1.0' as const;
export const CLI_PROFILE = 'beta-default' as const;
export type ScanErrorCode = WorkflowParseErrorCode | 'INPUT_READ_FAILED' | 'INTERNAL';

export type ScanDocument = ScanSuccessDocument | ScanErrorDocument;

type ScanSuccessDocument = {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  scannerResultSchemaVersion: typeof SCANNER_RESULT_SCHEMA_VERSION;
  scannerVersion: typeof SCANNER_VERSION;
  profile: typeof CLI_PROFILE;
  input: string;
  ok: true;
  workflow: {
    name: string | null;
    fingerprint: string;
    nodeCount: number;
    payloadBytes: number;
  };
  analysis: { status: string; diagnostics: AnalysisDiagnostic[] };
  summary: ScanSummary;
  findings: CanonicalScanFinding[];
  stats: { policyFailures: number; rejectedFindings: number; collapsedFindings: number };
};

type ScanErrorDocument = {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  scannerVersion: typeof SCANNER_VERSION;
  profile: typeof CLI_PROFILE;
  input: string;
  ok: false;
  error: { code: ScanErrorCode; message: string };
};

export function scanText(input: string, workflowJson: string): ScanDocument {
  const parsed = parseWorkflowJson(workflowJson, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
  if (!parsed.ok) return errorDocument(input, parsed.code, parsed.message);

  const profile = resolvePolicyProfile(CLI_PROFILE);
  if (!profile.ok) return errorDocument(input, 'INTERNAL', 'The configured scanner profile is unavailable.');

  try {
    const core = scanWorkflowCore(parsed.workflow, {
      policies: profile.createPolicies(),
      ruleCatalog: profile.ruleCatalog,
    });
    const attached = attachFindingSourceSpans(core.findings, parsed.workflow.nodes);
    const alreadyReported = core.diagnostics.some((diagnostic) => diagnostic.code === 'SOURCE_SPAN_UNAVAILABLE');
    const diagnostics = attached.unresolvedCount > 0 && !alreadyReported
      ? [...core.diagnostics, { code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' } as const]
      : core.diagnostics;
    const analysisStatus = attached.unresolvedCount > 0 && core.analysisStatus === 'COMPLETE'
      ? 'DEGRADED'
      : core.analysisStatus;
    return redactScanPresentation({
      schemaVersion: CLI_SCHEMA_VERSION,
      scannerResultSchemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
      scannerVersion: SCANNER_VERSION,
      profile: CLI_PROFILE,
      input,
      ok: true,
      workflow: {
        name: parsed.workflow.name ?? null,
        fingerprint: parsed.workflow.fingerprint,
        nodeCount: parsed.workflow.nodeCount,
        payloadBytes: parsed.workflow.payloadBytes,
      },
      analysis: { status: analysisStatus, diagnostics },
      summary: core.summary,
      findings: attached.findings,
      stats: {
        policyFailures: core.policyFailureCount,
        rejectedFindings: core.rejectedCount,
        collapsedFindings: core.collapsedCount,
      },
    });
  } catch {
    return errorDocument(input, 'INTERNAL', 'The scanner failed while analyzing the workflow.');
  }
}

export function versionDocument(): Record<string, string> {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    cliVersion: CLI_VERSION,
    scannerVersion: SCANNER_VERSION,
    profile: CLI_PROFILE,
    mode: 'offline',
  };
}

function errorDocument(
  input: string,
  code: ScanErrorCode,
  message: string,
): ScanErrorDocument {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    scannerVersion: SCANNER_VERSION,
    profile: CLI_PROFILE,
    input,
    ok: false,
    error: { code, message },
  };
}
