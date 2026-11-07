import type { AnalysisDiagnostic, ScanFinding } from '../../policy/policy';
import type { AnalyzerContextV2 } from '../../capabilities/scheduler';
import type { TaintPropagationResult } from './taint-propagation';

export type TaintOutcomeV1 = Readonly<{
  status: 'COMPLETE' | 'LIMITED' | 'FAILED';
  findings: readonly ScanFinding[];
  diagnostics: readonly AnalysisDiagnostic[];
  propagation?: TaintPropagationResult;
}>;
export type TaintAccessorV1 = () => TaintOutcomeV1;

const FAILED: TaintOutcomeV1 = Object.freeze({
  status: 'FAILED', findings: Object.freeze([]), diagnostics: Object.freeze([]),
});

function detachedOutcome(outcome: TaintOutcomeV1): TaintOutcomeV1 {
  return deepFreeze(structuredClone(outcome));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * One lazy producer per scan. The accessor captures its context and compute function; it never
 * accepts a consumer key, so a consumer cannot read another scan's result. Compute runs at most
 * once, including typed failure and limit outcomes.
 */
export function createScanLocalTaint(
  context: AnalyzerContextV2,
  compute: (context: AnalyzerContextV2) => TaintOutcomeV1,
): TaintAccessorV1 {
  let cached: TaintOutcomeV1 | undefined;
  let running = false;
  let failed = false;
  return () => {
    if (failed) return detachedOutcome(FAILED);
    if (cached !== undefined) return detachedOutcome(cached);
    if (running) {
      failed = true;
      return detachedOutcome(FAILED);
    }
    running = true;
    try {
      const produced = compute(context);
      cached = failed ? FAILED : produced;
      return detachedOutcome(cached);
    } catch {
      failed = true;
      cached = FAILED;
      return detachedOutcome(cached);
    } finally {
      running = false;
    }
  };
}
