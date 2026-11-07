import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits';
import {
  DEFAULT_SCANNER_LIMITS,
  SCANNER_LIMITS_SCHEMA_VERSION,
  serializeScannerLimits,
  toWorkflowParseOptions,
  validateScannerLimits,
  type ScannerLimitsV1,
} from './scanner-limits';
import { DEFAULT_SCANNER_LIMITS_V2, toWorkflowParseOptionsV2 } from './scanner-limits-v2';

function validLimits(overrides: Partial<ScannerLimitsV1> = {}): ScannerLimitsV1 {
  return { ...DEFAULT_SCANNER_LIMITS, ...overrides };
}

describe('DEFAULT_SCANNER_LIMITS', () => {
  it('is derived from the existing LIMITS constants, not a second copy of the numbers', () => {
    expect(DEFAULT_SCANNER_LIMITS.maxBytes).toBe(LIMITS.maxWorkflowBytes);
    expect(DEFAULT_SCANNER_LIMITS.maxNodes).toBe(LIMITS.maxNodes);
    expect(DEFAULT_SCANNER_LIMITS.workerDeadlineMs).toBe(LIMITS.scanTimeoutMs);
  });

  it('carries the granularity LIMITS never had', () => {
    expect(DEFAULT_SCANNER_LIMITS.maxEdges).toBeGreaterThan(0);
    expect(DEFAULT_SCANNER_LIMITS.maxConnectionDepth).toBeGreaterThan(0);
    expect(DEFAULT_SCANNER_LIMITS.maxParameterDepth).toBeGreaterThan(0);
    expect(DEFAULT_SCANNER_LIMITS.maxParameterLeaves).toBeGreaterThan(0);
  });

  it('is frozen so no caller can mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_SCANNER_LIMITS)).toBe(true);
  });

  it('passes its own validator', () => {
    expect(validateScannerLimits(DEFAULT_SCANNER_LIMITS)).toMatchObject({ ok: true });
  });
});

describe('validateScannerLimits', () => {
  it('accepts a structurally valid limits object', () => {
    const result = validateScannerLimits(validLimits({ maxNodes: 10 }));
    expect(result).toEqual({ ok: true, limits: validLimits({ maxNodes: 10 }) });
  });

  it('rejects a non-object candidate', () => {
    expect(validateScannerLimits(null)).toMatchObject({ ok: false });
    expect(validateScannerLimits('nope')).toMatchObject({ ok: false });
    expect(validateScannerLimits([1, 2, 3])).toMatchObject({ ok: false });
  });

  it('rejects a missing field', () => {
    const { maxNodes: _drop, ...rest } = validLimits();
    const result = validateScannerLimits(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('missing field: maxNodes');
  });

  it('rejects a non-integer field', () => {
    const result = validateScannerLimits(validLimits({ maxNodes: 1.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('maxNodes must be a non-negative integer');
  });

  it('rejects a negative field', () => {
    const result = validateScannerLimits(validLimits({ maxBytes: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('maxBytes must be a non-negative integer');
  });

  it('rejects an unknown field instead of silently ignoring it', () => {
    const result = validateScannerLimits({ ...validLimits(), extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('unknown field: extra');
  });

  it('fails closed on an unknown schema version rather than defaulting', () => {
    const result = validateScannerLimits(validLimits({ schemaVersion: 'scanner-limits-v2' as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('accumulates every violation instead of stopping at the first', () => {
    const result = validateScannerLimits({ maxBytes: -1, maxNodes: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(2);
    }
  });
});

describe('serializeScannerLimits', () => {
  it('is deterministic regardless of the input object property construction order', () => {
    const a = validLimits();
    const b: ScannerLimitsV1 = {
      workerDeadlineMs: a.workerDeadlineMs,
      maxParameterLeaves: a.maxParameterLeaves,
      maxParameterDepth: a.maxParameterDepth,
      maxConnectionDepth: a.maxConnectionDepth,
      maxEdges: a.maxEdges,
      maxNodes: a.maxNodes,
      maxBytes: a.maxBytes,
      schemaVersion: a.schemaVersion,
    };

    expect(serializeScannerLimits(a)).toBe(serializeScannerLimits(b));
    expect(serializeScannerLimits(a)).toBe(
      `{"schemaVersion":"${SCANNER_LIMITS_SCHEMA_VERSION}","maxBytes":${a.maxBytes},"maxNodes":${a.maxNodes},"maxEdges":${a.maxEdges},"maxConnectionDepth":${a.maxConnectionDepth},"maxParameterDepth":${a.maxParameterDepth},"maxParameterLeaves":${a.maxParameterLeaves},"workerDeadlineMs":${a.workerDeadlineMs}}`,
    );
  });
});

describe('toWorkflowParseOptions', () => {
  it('maps every field to the exact option name parseWorkflowJson expects', () => {
    expect(toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS)).toEqual({
      maxBytes: DEFAULT_SCANNER_LIMITS.maxBytes,
      maxNodes: DEFAULT_SCANNER_LIMITS.maxNodes,
      maxEdges: DEFAULT_SCANNER_LIMITS.maxEdges,
      maxConnectionDepth: DEFAULT_SCANNER_LIMITS.maxConnectionDepth,
      maxParameterDepth: DEFAULT_SCANNER_LIMITS.maxParameterDepth,
      maxParameterLeaves: DEFAULT_SCANNER_LIMITS.maxParameterLeaves,
    });
  });

  it('keeps the v2 projection byte-for-byte aligned with v1 defaults', () => {
    expect(toWorkflowParseOptionsV2(DEFAULT_SCANNER_LIMITS_V2)).toEqual(
      toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS),
    );
  });
});
