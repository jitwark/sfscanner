import type { Grade } from '@hub/contracts';
import { parseScannerResultSchemaVersion } from '@hub/contracts';

export type ScanResultLike = {
  schemaVersion?: unknown;
  riskAssessment?: { grade?: Grade; score?: number };
  summary?: { critical?: number; high?: number; medium?: number; low?: number; info?: number };
  findings?: Array<Record<string, unknown>>;
  analysisStatus?: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';
  analysisDiagnostics?: Array<{ code?: string }>;
};

const WORKER_UNSAFE_EXEC_ARGV = /^--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|max[-_]heap[-_]size|stack[-_]size)(?:=|$)/;
const DEFAULT_CORPUS_SCAN_CONCURRENCY = 4;
const MAX_CORPUS_SCAN_CONCURRENCY = 8;

export function workerSafeExecArgv(execArgv: string[]): string[] {
  return execArgv.filter((flag) => !WORKER_UNSAFE_EXEC_ARGV.test(flag));
}

/** Ensure the source worker remains runnable when a launcher omits tsx hooks. */
export function workerExecArgv(execArgv: string[]): string[] {
  const safeArgs = workerSafeExecArgv(execArgv);
  // tsx's CLI preflight/loader pair is not sufficient for Worker ESM entry
  // points on Windows; an explicit tsx/esm hook is required there.
  const hasExplicitTsxEntry = safeArgs.some((flag) => flag === 'tsx/esm');
  return hasExplicitTsxEntry ? safeArgs : [...safeArgs, '--import', 'tsx/esm'];
}

/** Keep build-time worker pressure bounded while retaining deterministic order. */
export function resolveCorpusScanConcurrency(value = process.env.CORPUS_SCAN_CONCURRENCY): number {
  if (value === undefined || !/^\d+$/u.test(value)) return DEFAULT_CORPUS_SCAN_CONCURRENCY;
  return Math.min(MAX_CORPUS_SCAN_CONCURRENCY, Math.max(1, Number(value)));
}

export function requireScannerResult(value: unknown, profile: string): ScanResultLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Scanner ${profile} result is not an object`);
  }
  const result = value as ScanResultLike;
  parseScannerResultSchemaVersion(result.schemaVersion);
  return result;
}
