import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCANNER_LIMITS_V2,
  SCANNER_LIMITS_V2_SCHEMA_VERSION,
  toWorkflowParseOptionsV2,
  validateScannerLimitsV2,
  type ScannerLimitsV2,
} from './scanner-limits-v2';

const numericFields = [
  'maxBytes', 'maxNodes', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth',
  'maxParameterLeaves', 'workerDeadlineMs', 'maxSyntaxNodes', 'maxDocumentDepth',
  'maxMembersAndElements', 'maxRawEdges', 'maxDuplicateKeys', 'maxDiagnostics',
  'maxStoredSourceSpans', 'maxSourceWork', 'maxExpressionTokens', 'maxCodeSyntaxNodes',
  'maxGraphOperations', 'maxTaintStates', 'maxTraceStepsPerFinding', 'maxFindings',
  'maxRedactionPatches', 'maxRedactedArtifactBytes', 'maxEvidenceBytes',
  'maxSerializedResultBytes', 'maxRuleOperations',
] as const satisfies readonly (keyof Omit<ScannerLimitsV2, 'schemaVersion'>)[];

function validLimits(overrides: Partial<ScannerLimitsV2> = {}): ScannerLimitsV2 {
  return { ...DEFAULT_SCANNER_LIMITS_V2, ...overrides };
}

describe('DEFAULT_SCANNER_LIMITS_V2', () => {
  it('has the frozen schema and exact v1/v2 defaults', () => {
    expect(DEFAULT_SCANNER_LIMITS_V2).toEqual({
      schemaVersion: SCANNER_LIMITS_V2_SCHEMA_VERSION,
      maxBytes: 1_536_000,
      maxNodes: 5_000,
      maxEdges: 10_000,
      maxConnectionDepth: 64,
      maxParameterDepth: 64,
      maxParameterLeaves: 10_000,
      workerDeadlineMs: 30_000,
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
    expect(Object.isFrozen(DEFAULT_SCANNER_LIMITS_V2)).toBe(true);
  });

  it('passes its own validator and projects only the v1 parser fields', () => {
    expect(validateScannerLimitsV2(DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(toWorkflowParseOptionsV2(DEFAULT_SCANNER_LIMITS_V2)).toEqual({
      maxBytes: 1_536_000,
      maxNodes: 5_000,
      maxEdges: 10_000,
      maxConnectionDepth: 64,
      maxParameterDepth: 64,
      maxParameterLeaves: 10_000,
    });
    expect(Object.keys(toWorkflowParseOptionsV2(DEFAULT_SCANNER_LIMITS_V2))).toEqual([
      'maxBytes', 'maxNodes', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth', 'maxParameterLeaves',
    ]);
  });
});

describe('validateScannerLimitsV2', () => {
  it.each(numericFields)('accepts %s at max-1, max, and max+1', (field) => {
    const maximum = DEFAULT_SCANNER_LIMITS_V2[field];
    for (const value of [maximum - 1, maximum, maximum + 1]) {
      expect(validateScannerLimitsV2(validLimits({ [field]: value }))).toMatchObject({ ok: true });
    }
  });

  it('rejects missing and unknown keys', () => {
    const { maxNodes: _missing, ...missing } = validLimits();
    const missingResult = validateScannerLimitsV2(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.errors).toContain('missing field: maxNodes');

    const unknownResult = validateScannerLimitsV2({ ...validLimits(), extra: 1 });
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.errors).toContain('unknown field: extra');
  });

  it.each(numericFields)('rejects an unsafe integer in %s', (field) => {
    const result = validateScannerLimitsV2(validLimits({ [field]: Number.MAX_SAFE_INTEGER + 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(`${field} must be a non-negative safe integer`);
  });

  it.each(numericFields)('accepts explicit zero for %s except the reserved diagnostic budget', (field) => {
    const result = validateScannerLimitsV2(validLimits({ [field]: 0 }));
    expect(result.ok).toBe(field !== 'maxDiagnostics');
    if (field === 'maxDiagnostics' && !result.ok) {
      expect(result.errors).toContain('maxDiagnostics must be at least 1');
    }
  });

  it('reports every error in stable field order regardless of input key order', () => {
    const first = {
      schemaVersion: 'wrong', maxBytes: -1, maxNodes: 1.5, maxEdges: Number.MAX_SAFE_INTEGER + 1,
      maxConnectionDepth: -1, maxParameterDepth: 'bad', maxParameterLeaves: 0, workerDeadlineMs: 0,
      maxSyntaxNodes: 0, maxDocumentDepth: 0, maxMembersAndElements: 0, maxRawEdges: 0,
      maxDuplicateKeys: 0, maxDiagnostics: 0, maxStoredSourceSpans: 0, maxExpressionTokens: 0,
      maxSourceWork: 0,
      maxCodeSyntaxNodes: 0, maxGraphOperations: 0, maxTaintStates: 0, maxTraceStepsPerFinding: 0,
      maxFindings: 0, maxRedactionPatches: 0, maxRedactedArtifactBytes: 0, maxEvidenceBytes: 0,
      maxSerializedResultBytes: 0, maxRuleOperations: 0, zebra: true, alpha: true,
    };
    const second = { alpha: true, zebra: true, ...first };
    const firstResult = validateScannerLimitsV2(first);
    const secondResult = validateScannerLimitsV2(second);
    expect(firstResult.ok).toBe(false);
    expect(secondResult).toEqual(firstResult);
    if (!firstResult.ok) {
      expect(firstResult.errors.slice(0, 4)).toEqual([
        'unknown field: alpha', 'unknown field: zebra', 'unsupported schemaVersion: wrong',
        'maxBytes must be a non-negative safe integer',
      ]);
      expect(firstResult.errors).toContain('maxDiagnostics must be at least 1');
    }
  });
});
