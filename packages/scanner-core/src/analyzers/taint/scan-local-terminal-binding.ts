import type { ScanLocalFlowFactsV1 } from './scan-local-flow-facts';
import type { ScanLocalFlowCandidateV1, ScanLocalTerminalInputReadV1,
  ScanLocalWitnessChannelV1 } from './scan-local-flows';
import type { ScanLocalChargeV1 } from './scan-local-state';

type EmittedTerminalFactsV1 = Extract<ScanLocalFlowFactsV1, { status: 'EMITTED' }>;

/** Only an exact, KNOWN emitted summary can bind a terminal read; suppression has no scope metadata. */
export function isKnownTerminalEmissionBoundToRead(
  emission: ScanLocalFlowFactsV1,
  channel: ScanLocalWitnessChannelV1,
  read: ScanLocalTerminalInputReadV1,
): emission is EmittedTerminalFactsV1 {
  if (emission.status !== 'EMITTED') return false;
  const properties = emission.summary?.properties;
  if (properties === null || typeof properties !== 'object' || properties.knowledge !== 'KNOWN'
    || properties.sinkParameterPath !== read.sinkParameterPath || properties.edgeChannel !== channel) return false;
  return samePath(properties.sourceFieldPath, read.path)
    && samePath(emission.provenance?.properties?.sourceFieldPath, read.path);
}

/** Associate facts only after the terminal witness and fact materialization are fully admitted. */
export function recordAdmittedTerminalEmission(
  candidate: ScanLocalFlowCandidateV1 | undefined,
  emission: ScanLocalFlowFactsV1 | undefined,
  measured: boolean,
  channel: ScanLocalWitnessChannelV1,
  read: ScanLocalTerminalInputReadV1,
  charge: ScanLocalChargeV1,
  record: (candidate: ScanLocalFlowCandidateV1, emission: EmittedTerminalFactsV1,
    charge: ScanLocalChargeV1) => void,
): boolean {
  if (!measured || candidate === undefined || emission === undefined
    || !isKnownTerminalEmissionBoundToRead(emission, channel, read)) return false;
  let recorded = false;
  record(candidate, emission, (units) => (recorded = charge(units)));
  return recorded;
}

function samePath(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}
