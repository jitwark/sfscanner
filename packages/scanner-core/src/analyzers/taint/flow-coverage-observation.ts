import type { ScanLocalFlowFactsV1 } from './scan-local-flow-facts';
import type { ScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import { SCAN_LOCAL_LIMITS_V1, type ScanLocalChargeV1 } from './scan-local-state';

export type FlowCoverageObservationV1 = Readonly<{
  candidate: ScanLocalFlowCandidateV1;
  emission: ScanLocalFlowFactsV1;
}>;
export type FlowCoverageSnapshotV1 =
  | Readonly<{ status: 'OBSERVED'; rows: readonly FlowCoverageObservationV1[] }>
  | Readonly<{ status: 'REFUSED'; reason: 'NO_CHARGE' | 'BUDGET_EXHAUSTED' }>;
export type FlowCoverageLogV1 = Readonly<{
  captureCharge(charge: ScanLocalChargeV1): void;
  wrapEmitter(emit: ScanLocalFlowFactEmitterV1): ScanLocalFlowFactEmitterV1;
  snapshot(finalCandidates: readonly ScanLocalFlowCandidateV1[]): FlowCoverageSnapshotV1;
}>;

const OBSERVATION_SLOT_UNITS = 1;
const SNAPSHOT_HEADER_UNITS = 1;
const snapshotCharges = new WeakMap<object, ScanLocalChargeV1>();

function omittedBudget(): ScanLocalFlowFactsV1 {
  return Object.freeze({ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' });
}

function refused(reason: 'NO_CHARGE' | 'BUDGET_EXHAUSTED'): FlowCoverageSnapshotV1 {
  return Object.freeze({ status: 'REFUSED', reason });
}

function boundedCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
    && value <= SCAN_LOCAL_LIMITS_V1.maxFieldStates;
}

function checkedUnits(left: number, right: number): number | undefined {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) return;
  const total = left + right;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function createFlowCoverageLogV1(): FlowCoverageLogV1 {
  const rows: FlowCoverageObservationV1[] = [];
  let storedCharge: ScanLocalChargeV1 | undefined;
  let budgetRefused = false;

  return Object.freeze({
    captureCharge(charge) {
      if (storedCharge === undefined) {
        storedCharge = charge;
        return;
      }
      if (storedCharge !== charge) throw new TypeError('flow coverage charge handle changed');
    },

    wrapEmitter(emit) {
      return (candidate, charge) => {
        if (budgetRefused) return omittedBudget();
        if (!charge(OBSERVATION_SLOT_UNITS)) {
          budgetRefused = true;
          return omittedBudget();
        }
        if (rows.length >= SCAN_LOCAL_LIMITS_V1.maxFieldStates) {
          budgetRefused = true;
          return omittedBudget();
        }
        // The slot is reserved before the unchanged emitter runs. Its union, including a refusal,
        // is retained as the exact executed observation and returned without reinterpretation.
        const emission = emit(candidate, charge);
        rows.push(Object.freeze({ candidate, emission }));
        return emission;
      };
    },

    snapshot(finalCandidates) {
      if (storedCharge === undefined) return refused('NO_CHARGE');
      if (budgetRefused) return refused('BUDGET_EXHAUSTED');

      // Pay one unit before reading the dynamic list descriptor, then pay the complete remaining
      // membership/filter cost before constructing or walking either collection.
      if (!storedCharge(SNAPSHOT_HEADER_UNITS)) {
        budgetRefused = true;
        return refused('BUDGET_EXHAUSTED');
      }
      const storedCount = rows.length;
      const finalCount = finalCandidates.length;
      if (!boundedCount(storedCount) || !boundedCount(finalCount)) {
        budgetRefused = true;
        return refused('BUDGET_EXHAUSTED');
      }
      const membership = checkedUnits(finalCount, finalCount);
      const remaining = membership === undefined
        ? undefined
        : checkedUnits(storedCount, membership);
      if (remaining === undefined || (remaining > 0 && !storedCharge(remaining))) {
        budgetRefused = true;
        return refused('BUDGET_EXHAUSTED');
      }

      const survivors = new Set(finalCandidates);
      const finalRows: FlowCoverageObservationV1[] = [];
      for (const row of rows) if (survivors.has(row.candidate)) finalRows.push(row);
      const snapshot = Object.freeze({ status: 'OBSERVED' as const, rows: Object.freeze(finalRows) });
      snapshotCharges.set(snapshot, storedCharge);
      return snapshot;
    },
  });
}

export function withFlowCoverageChargeV1<T>(
  snapshot: FlowCoverageSnapshotV1,
  work: (charge: ScanLocalChargeV1) => T,
): Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: 'NO_CHARGE' }> {
  const charge = snapshotCharges.get(snapshot);
  if (charge === undefined) return Object.freeze({ ok: false, reason: 'NO_CHARGE' });
  return Object.freeze({ ok: true, value: work(charge) });
}
