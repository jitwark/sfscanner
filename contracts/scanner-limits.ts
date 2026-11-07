import { LIMITS } from './limits';

/**
 * The one versioned scanner-limits contract browser, worker, and pipeline
 * callers share. `LIMITS` (limits.ts) stays the source for the three numbers
 * it already owned (maxWorkflowBytes/maxNodes/scanTimeoutMs are read from it
 * below, not re-declared) so this cannot silently drift from it.
 */
export const SCANNER_LIMITS_SCHEMA_VERSION = 'scanner-limits-v1' as const;

export type ScannerLimitsV1 = {
  schemaVersion: typeof SCANNER_LIMITS_SCHEMA_VERSION;
  maxBytes: number;
  maxNodes: number;
  maxEdges: number;
  maxConnectionDepth: number;
  maxParameterDepth: number;
  maxParameterLeaves: number;
  workerDeadlineMs: number;
};

const SCANNER_LIMITS_FIELDS = [
  'schemaVersion',
  'maxBytes',
  'maxNodes',
  'maxEdges',
  'maxConnectionDepth',
  'maxParameterDepth',
  'maxParameterLeaves',
  'workerDeadlineMs',
] as const satisfies readonly (keyof ScannerLimitsV1)[];

export const DEFAULT_SCANNER_LIMITS: ScannerLimitsV1 = Object.freeze({
  schemaVersion: SCANNER_LIMITS_SCHEMA_VERSION,
  maxBytes: LIMITS.maxWorkflowBytes,
  maxNodes: LIMITS.maxNodes,
  maxEdges: 10_000,
  // Previously declared as a `workflow.ts` option but never wired to any
  // production caller (see scanner-contract-and-calibration tasks.md P1.1) —
  // this is the first real default for it.
  maxConnectionDepth: 64,
  maxParameterDepth: 64,
  maxParameterLeaves: 10_000,
  workerDeadlineMs: LIMITS.scanTimeoutMs,
});

export type ScannerLimitsValidationResult =
  | { ok: true; limits: ScannerLimitsV1 }
  | { ok: false; errors: string[] };

/** Fails closed and reports every violation, not just the first, so a bad config is fully diagnosable. */
export function validateScannerLimits(candidate: unknown): ScannerLimitsValidationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, errors: ['limits must be an object'] };
  }

  const value = candidate as Record<string, unknown>;
  const errors: string[] = [];
  const knownFields = new Set<string>(SCANNER_LIMITS_FIELDS);

  for (const field of Object.keys(value)) {
    if (!knownFields.has(field)) errors.push(`unknown field: ${field}`);
  }

  if (value.schemaVersion !== SCANNER_LIMITS_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }

  for (const field of SCANNER_LIMITS_FIELDS) {
    if (field === 'schemaVersion') continue;
    if (!(field in value)) {
      errors.push(`missing field: ${field}`);
      continue;
    }
    const raw = value[field];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      errors.push(`${field} must be a non-negative integer`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    limits: {
      schemaVersion: SCANNER_LIMITS_SCHEMA_VERSION,
      maxBytes: value.maxBytes as number,
      maxNodes: value.maxNodes as number,
      maxEdges: value.maxEdges as number,
      maxConnectionDepth: value.maxConnectionDepth as number,
      maxParameterDepth: value.maxParameterDepth as number,
      maxParameterLeaves: value.maxParameterLeaves as number,
      workerDeadlineMs: value.workerDeadlineMs as number,
    },
  };
}

/** Stable key order regardless of the input object's own construction order. */
export function serializeScannerLimits(limits: ScannerLimitsV1): string {
  return JSON.stringify(limits, SCANNER_LIMITS_FIELDS as unknown as string[]);
}

/** The exact option shape `parseWorkflowJson` accepts — one mapping, not one per caller. */
export function toWorkflowParseOptions(limits: ScannerLimitsV1): {
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
