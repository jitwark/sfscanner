import {
  DEFAULT_SCANNER_LIMITS,
  type ScannerLimitsV1,
} from './scanner-limits';

export const SCANNER_LIMITS_V2_SCHEMA_VERSION = 'scanner-limits-v2' as const;

const SCANNER_LIMITS_V2_NUMERIC_FIELDS = [
  'maxBytes',
  'maxNodes',
  'maxEdges',
  'maxConnectionDepth',
  'maxParameterDepth',
  'maxParameterLeaves',
  'workerDeadlineMs',
  'maxSyntaxNodes',
  'maxDocumentDepth',
  'maxMembersAndElements',
  'maxRawEdges',
  'maxDuplicateKeys',
  'maxDiagnostics',
  'maxStoredSourceSpans',
  'maxSourceWork',
  'maxExpressionTokens',
  'maxCodeSyntaxNodes',
  'maxGraphOperations',
  'maxTaintStates',
  'maxTraceStepsPerFinding',
  'maxFindings',
  'maxRedactionPatches',
  'maxRedactedArtifactBytes',
  'maxEvidenceBytes',
  'maxSerializedResultBytes',
  'maxRuleOperations',
] as const;

const SCANNER_LIMITS_V2_FIELDS = [
  'schemaVersion',
  ...SCANNER_LIMITS_V2_NUMERIC_FIELDS,
] as const;

export type ScannerLimitsV2 = Omit<ScannerLimitsV1, 'schemaVersion'> & {
  schemaVersion: typeof SCANNER_LIMITS_V2_SCHEMA_VERSION;
  maxSyntaxNodes: number;
  maxDocumentDepth: number;
  maxMembersAndElements: number;
  maxRawEdges: number;
  maxDuplicateKeys: number;
  maxDiagnostics: number;
  maxStoredSourceSpans: number;
  maxSourceWork: number;
  maxExpressionTokens: number;
  maxCodeSyntaxNodes: number;
  maxGraphOperations: number;
  maxTaintStates: number;
  maxTraceStepsPerFinding: number;
  maxFindings: number;
  maxRedactionPatches: number;
  maxRedactedArtifactBytes: number;
  maxEvidenceBytes: number;
  maxSerializedResultBytes: number;
  maxRuleOperations: number;
};

export const DEFAULT_SCANNER_LIMITS_V2: ScannerLimitsV2 = Object.freeze({
  ...DEFAULT_SCANNER_LIMITS,
  schemaVersion: SCANNER_LIMITS_V2_SCHEMA_VERSION,
  maxSyntaxNodes: 250_000,
  maxDocumentDepth: 256,
  maxMembersAndElements: 250_000,
  maxRawEdges: 50_000,
  maxDuplicateKeys: 1_000,
  maxDiagnostics: 1_000,
  maxStoredSourceSpans: 25_000,
  maxSourceWork: 1_000_000,
  maxExpressionTokens: 100_000,
  maxCodeSyntaxNodes: 250_000,
  maxGraphOperations: 1_000_000,
  maxTaintStates: 250_000,
  maxTraceStepsPerFinding: 100,
  maxFindings: 5_000,
  maxRedactionPatches: 10_000,
  maxRedactedArtifactBytes: 1_536_000,
  maxEvidenceBytes: 1_536_000,
  maxSerializedResultBytes: 5_000_000,
  maxRuleOperations: 1_000_000,
});

export type ScannerLimitsV2ValidationResult =
  | { ok: true; limits: ScannerLimitsV2 }
  | { ok: false; errors: string[] };

export type AdmittedLimitStateV2 = 'WIRED' | 'DORMANT' | 'UNWIRED';
export type ScannerLimitNameV2 = (typeof SCANNER_LIMITS_V2_NUMERIC_FIELDS)[number];

/**
 * The one authority every help surface and usage row reads. `WIRED` is consumed by the admitted
 * beta-default path, `DORMANT` only by an unadmitted profile (the hardened code, value-flow, taint
 * and graph analyzers), and `UNWIRED` by no shipped path (redaction-v2 is development-only).
 * `workerDeadlineMs` is wired because the CLI worker host enforces it.
 */
export const ADMITTED_LIMIT_STATES: Readonly<Record<ScannerLimitNameV2, AdmittedLimitStateV2>> = Object.freeze({
  maxBytes: 'WIRED',
  maxNodes: 'WIRED',
  maxEdges: 'WIRED',
  maxConnectionDepth: 'WIRED',
  maxParameterDepth: 'WIRED',
  maxParameterLeaves: 'WIRED',
  workerDeadlineMs: 'WIRED',
  maxSyntaxNodes: 'WIRED',
  maxDocumentDepth: 'WIRED',
  maxMembersAndElements: 'WIRED',
  maxRawEdges: 'WIRED',
  maxDuplicateKeys: 'WIRED',
  maxDiagnostics: 'WIRED',
  maxStoredSourceSpans: 'WIRED',
  maxSourceWork: 'WIRED',
  maxExpressionTokens: 'DORMANT',
  maxCodeSyntaxNodes: 'DORMANT',
  maxGraphOperations: 'WIRED',
  maxTaintStates: 'WIRED',
  maxTraceStepsPerFinding: 'WIRED',
  maxFindings: 'WIRED',
  maxRedactionPatches: 'UNWIRED',
  maxRedactedArtifactBytes: 'UNWIRED',
  maxEvidenceBytes: 'WIRED',
  maxSerializedResultBytes: 'WIRED',
  maxRuleOperations: 'WIRED',
});

/**
 * The subset with a real per-scan counter. The narrow tuple is deliberate: a wide annotation would
 * make every one of the 26 names assignable, so the 13-key counter object below would not typecheck.
 * A budget without a counter is enforced where it is consumed but has no honest `usage` row.
 */
export const MEASURED_LIMIT_IDS = [
  'maxBytes', 'maxNodes', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth',
  'maxParameterLeaves', 'maxSyntaxNodes', 'maxRawEdges', 'maxDuplicateKeys',
  'maxDiagnostics', 'maxStoredSourceSpans', 'maxSourceWork', 'maxFindings',
] as const satisfies readonly ScannerLimitNameV2[];

export function validateScannerLimitsV2(candidate: unknown): ScannerLimitsV2ValidationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, errors: ['limits must be an object'] };
  }

  const value = candidate as Record<string, unknown>;
  const knownFields = new Set<string>(SCANNER_LIMITS_V2_FIELDS);
  const errors = Object.keys(value)
    .filter((field) => !knownFields.has(field))
    .sort()
    .map((field) => `unknown field: ${field}`);

  if (!Object.prototype.hasOwnProperty.call(value, 'schemaVersion')) {
    errors.push('missing field: schemaVersion');
  } else if (value.schemaVersion !== SCANNER_LIMITS_V2_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }

  for (const field of SCANNER_LIMITS_V2_NUMERIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(`missing field: ${field}`);
      continue;
    }
    const raw = value[field];
    if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
      errors.push(`${field} must be a non-negative safe integer`);
    } else if (field === 'maxDiagnostics' && (raw as number) < 1) {
      errors.push('maxDiagnostics must be at least 1');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    limits: {
      schemaVersion: SCANNER_LIMITS_V2_SCHEMA_VERSION,
      ...Object.fromEntries(SCANNER_LIMITS_V2_NUMERIC_FIELDS.map((field) => [field, value[field]])),
    } as ScannerLimitsV2,
  };
}

export function toWorkflowParseOptionsV2(limits: ScannerLimitsV2): {
  maxBytes: number;
  maxNodes: number;
  maxEdges: number;
  maxConnectionDepth: number;
  maxParameterDepth: number;
  maxParameterLeaves: number;
} {
  return {
    maxBytes: limits.maxBytes,
    maxNodes: limits.maxNodes,
    maxEdges: limits.maxEdges,
    maxConnectionDepth: limits.maxConnectionDepth,
    maxParameterDepth: limits.maxParameterDepth,
    maxParameterLeaves: limits.maxParameterLeaves,
  };
}
