import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type {
  Candidate,
  EntrySecurity,
  Grade,
} from '@hub/contracts';
import {
  DEFAULT_SCANNER_LIMITS,
  LIMITS,
  SCANNER_RESULT_SCHEMA_VERSION,
  toWorkflowParseOptions,
} from '@hub/contracts';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { requireScannerResult, workerExecArgv, type ScanResultLike } from './scan-runtime-boundary.js';
import { getScannerVersion, projectFinding, sortFindings } from './scanner-core-adapter.js';
export { getScannerVersion, projectFinding, sortFindings } from './scanner-core-adapter.js';
export type ScanCandidateOptions = {
  scan?: (
    workflow: NormalizedWorkflow,
    options?: { policyProfile?: 'beta-default' | 'beta-hardened' }
  ) => unknown;
  timeoutMs?: number;
  scannerVersion?: string;
  /**
   * Called the moment `parseWorkflowJson` refuses the body, with the parser's
   * own failure code, before the scan falls back to its indeterminate verdict.
   * It exists so a caller can ledger exactly which fixtures could not be read
   * instead of inferring it from the published state, where another scan
   * failure would look identical.
   */
  onUnparseable?: (failure: { candidateId: string; code: string }) => void;
};

type WorkerScanResult = { defaultResult: unknown; hardenedResult: unknown };

export function scanWithWorker(workflow: unknown, timeoutMs: number): Promise<WorkerScanResult> {
  return new Promise((resolve, reject) => {
    // The JavaScript bootstrap registers tsx's CommonJS hook. The package core
    // intentionally publishes import-only targets, so expose that condition
    // to the bootstrap's require() without changing package metadata.
    const worker = new Worker(new URL('./scan-worker-bootstrap.mjs', import.meta.url), {
      execArgv: [...workerExecArgv(process.execArgv), '--conditions=import'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().finally(() => reject(new Error(`Scan timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    worker.once('message', (message: { ok?: boolean; defaultResult?: unknown; hardenedResult?: unknown; error?: string }) => {
      if (message.ok !== true) {
        finish(() => reject(new Error(message.error ?? 'Scan worker failed')));
        return;
      }
      finish(() => resolve({ defaultResult: message.defaultResult, hardenedResult: message.hardenedResult }));
      void worker.terminate();
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`Scan worker exited with code ${code}`)));
    });
    worker.postMessage({ workflow });
  });
}

export async function scanCandidate(
  candidate: Candidate,
  options: ScanCandidateOptions = {}
): Promise<EntrySecurity> {
  const timeoutMs = options.timeoutMs ?? LIMITS.scanTimeoutMs;
  const scannerVersion = options.scannerVersion ?? 'unknown';

  const defaultSecurity: EntrySecurity = {
    grade: 'UNKNOWN',
    score: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion,
    profile: 'beta-default',
    analysisStatus: 'INDETERMINATE',
  };

  if (!candidate || candidate.json === undefined || candidate.json === null) {
    return defaultSecurity;
  }

  try {
    const runScan = async () => {
      const jsonStr = typeof candidate.json === 'string' ? candidate.json : JSON.stringify(candidate.json);
      if (typeof jsonStr !== 'string') throw new Error('workflow could not be serialized');
      const parsed = parseWorkflowJson(jsonStr, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
      if (!parsed.ok) {
        // Handing raw, unnormalized JSON to the engine makes it fail deep inside
        // a policy with an unhelpful "cannot read properties of undefined".
        // An unparseable workflow is simply not scannable: say so and move on.
        options.onUnparseable?.({ candidateId: candidate.id, code: parsed.code });
        throw new Error(`workflow did not parse: ${parsed.code}`);
      }
      const wfInput = parsed.workflow;
      let rawDefault: unknown;
      let rawHardened: unknown;
      if (options.scan) {
        rawDefault = await Promise.resolve(options.scan(wfInput, { policyProfile: 'beta-default' }));
        rawHardened = await Promise.resolve(options.scan(wfInput, { policyProfile: 'beta-hardened' }));
      } else {
        const workerResult = await scanWithWorker(jsonStr, timeoutMs); // AUDIT-SCAN-002: raw source, not wfInput
        rawDefault = workerResult.defaultResult;
        rawHardened = workerResult.hardenedResult;
      }
      const defaultResult = requireScannerResult(rawDefault, 'default');
      const hardenedResult = requireScannerResult(rawHardened, 'hardened');

      let hardenedExtra = 0;
      try {
        const defaultKeys = new Set(
          (defaultResult.findings || []).map((f) => {
            const loc = (f.location && typeof f.location === 'object' ? f.location : {}) as Record<string, unknown>;
            return `${f.policyId ?? f.id}:${loc.nodeName ?? loc.nodeId ?? f.node ?? ''}`;
          })
        );

        for (const f of hardenedResult.findings || []) {
          const loc = (f.location && typeof f.location === 'object' ? f.location : {}) as Record<string, unknown>;
          const key = `${f.policyId ?? f.id}:${loc.nodeName ?? loc.nodeId ?? f.node ?? ''}`;
          if (!defaultKeys.has(key)) {
            hardenedExtra++;
          }
        }
      } catch {
        hardenedExtra = 0;
      }

      const grade: Grade = defaultResult.riskAssessment?.grade ?? 'UNKNOWN';
      const score: number =
        typeof defaultResult.riskAssessment?.score === 'number'
          ? defaultResult.riskAssessment.score
          : 0;

      const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      if (defaultResult.summary) {
        counts.critical = defaultResult.summary.critical ?? 0;
        counts.high = defaultResult.summary.high ?? 0;
        counts.medium = defaultResult.summary.medium ?? 0;
        counts.low = defaultResult.summary.low ?? 0;
        counts.info = defaultResult.summary.info ?? 0;
      } else {
        for (const f of defaultResult.findings || []) {
          const sevStr = typeof f.severity === 'string' ? f.severity.toLowerCase() : '';
          const sev = sevStr as keyof typeof counts;
          if (sev in counts) counts[sev]++;
        }
      }

      const rawFindings = (defaultResult.findings || []).map(projectFinding);
      const findings = sortFindings(rawFindings).slice(0, LIMITS.maxPublicFindings);
      const analysisDiagnosticCodes = (defaultResult.analysisDiagnostics || [])
        .map((d) => d.code).filter((code): code is string => typeof code === 'string');

      return {
        schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
        grade,
        score,
        counts,
        findings,
        hardenedExtra,
        scannerVersion,
        profile: 'beta-default' as const,
        ...(defaultResult.analysisStatus ? { analysisStatus: defaultResult.analysisStatus } : {}),
        ...(analysisDiagnosticCodes.length > 0 ? { analysisDiagnosticCodes } : {}),
      };
    };

    // Injected scanners are test-only and may be synchronous. Production
    // scans use scanWithWorker above, where the deadline can terminate CPU work.
    return await runScan();
  } catch (err) {
    console.warn(`Scan failed for candidate ${candidate.id}:`, err instanceof Error ? err.message : err);
    return defaultSecurity;
  }
}

export async function scanCandidates(
  candidates: Candidate[],
  options: ScanCandidateOptions & { concurrency?: number } = {}
): Promise<EntrySecurity[]> {
  const concurrency = Math.max(1, options.concurrency ?? (os.cpus().length - 1));
  const results: EntrySecurity[] = new Array(candidates.length);
  let index = 0;

  const worker = async () => {
    while (index < candidates.length) {
      const i = index++;
      results[i] = await scanCandidate(candidates[i], options);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
