import {
  atomKey, compareCodeUnits, isValidFieldPath, type FieldStateV1, type ScanLocalChargeV1,
  type TaintAtomV1,
} from './scan-local-state';
import {
  getScanLocalRunToken, type ScanLocalPublishV1, type ScanLocalPublishedStateV1,
  type ScanLocalWorklistResultV1,
} from './scan-local-worklist';
import type { TaintTraceStepV2 } from '../taint-v2/transfer';
import { validStep } from '../taint-v2/trace-helpers';

export type ScanLocalWitnessChannelV1 = 'DATA' | 'CONTROL' | 'ERROR' | 'MODEL' | 'TOOL' | 'CONTEXT';
export type ScanLocalTerminalInputReadV1 = Readonly<{
  channel: ScanLocalWitnessChannelV1;
  path: readonly string[];
  sinkParameterPath: string;
  carrier: TaintTraceStepV2;
}>;

/** Candidates record the exact executed state observation. */
export type ScanLocalFlowCandidateV1 = Readonly<{
  atom: TaintAtomV1;
  sourceNode: string;
  sinkNode: string;
  sinkState: FieldStateV1;
  observation: 'TRANSFER_OUTPUT' | 'TERMINAL_INPUT_READ';
  terminalInputRead?: ScanLocalTerminalInputReadV1;
  omittedAtoms: number;
  omittedTokens: number;
}>;
export type ScanLocalFlowOutcomeV1 = Readonly<{
  status: 'COMPLETE' | 'LIMITED';
  fields: ReadonlyMap<string, FieldStateV1>;
  candidates: readonly ScanLocalFlowCandidateV1[];
  composed: boolean;
  omittedAtoms: number;
  omittedTokens: number;
  omittedAtomsByKind: Readonly<{ seed: number; transfer: number; enqueue: number }>;
  omittedTokensByKind: Readonly<{ seed: number; transfer: number; enqueue: number }>;
  invalidRequests: number;
  unmappedSources: number;
  unpublishedSinks: number;
  absentAtSinks: number;
  incompleteTransfers: number;
}>;
export type ScanLocalFlowCollectorV1 = Readonly<{
  publish: ScanLocalPublishV1;
  collect: (analysis: ScanLocalWorklistResultV1) => ScanLocalFlowOutcomeV1;
}>;

type OmissionKindV1 = 'seed' | 'transfer' | 'enqueue';
type PreparedRequestV1 = Readonly<{ ordinal: number; atom: TaintAtomV1; sourceNode: string; sinkNode: string }>;
type SinkRecordV1 = Readonly<{ generation: number; state: FieldStateV1; omittedAtoms: number; omittedTokens: number; complete: boolean }>;
type SlotV1 = Readonly<{ candidate: ScanLocalFlowCandidateV1 | null; generation: number }>;
const KIND_KEY: Readonly<Record<ScanLocalPublishedStateV1['kind'], OmissionKindV1>> =
  Object.freeze({ SEED: 'seed', TRANSFER: 'transfer', ENQUEUE: 'enqueue' });

function atomKeyCost(atoms: readonly TaintAtomV1[]): number {
  let cost = 0;
  for (const atom of atoms) cost += 1 + atom.field.length;
  return cost;
}

export function createScanLocalFlowCollector(input: Readonly<{
  sources: ReadonlyMap<string, string>;
  requests: readonly Readonly<{ atom: TaintAtomV1; sink: string }>[];
  /** Optional per-candidate hook, prepaid from the same publication charge; a refusal unpublishes it. */
  onCandidate?: (candidate: ScanLocalFlowCandidateV1, charge: ScanLocalChargeV1) => void;
}>): ScanLocalFlowCollectorV1 {
  const seen = new Set<string>();
  const resolved = new Map<string, Omit<PreparedRequestV1, 'ordinal'>>();
  let invalidRequests = 0;
  let unmappedSources = 0;
  for (const { atom, sink } of input.requests) {
    const key = `${atomKey(atom)}\u0000${sink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isAdmissibleScanLocalFlowRequest(atom, sink)) {
      invalidRequests += 1;
      continue;
    }
    const sourceNode = input.sources.get(atom.sourceId);
    if (sourceNode === undefined || sourceNode.length === 0) { unmappedSources += 1; continue; }
    resolved.set(key, {
      atom: Object.freeze({ sourceId: atom.sourceId, channel: atom.channel, field: Object.freeze([...atom.field]) }),
      sourceNode, sinkNode: sink,
    });
  }
  const prepared = Object.freeze([...resolved.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, request], ordinal): PreparedRequestV1 => Object.freeze({ ...request, ordinal })));
  const bySink = new Map<string, PreparedRequestV1[]>();
  for (const request of prepared) {
    const requests = bySink.get(request.sinkNode);
    if (requests === undefined) bySink.set(request.sinkNode, [request]);
    else requests.push(request);
  }
  const byKind: Record<OmissionKindV1, { atoms: number; tokens: number }> = {
    seed: { atoms: 0, tokens: 0 }, transfer: { atoms: 0, tokens: 0 }, enqueue: { atoms: 0, tokens: 0 },
  };
  const generations = new Map<string, number>();
  const records = new Map<string, SinkRecordV1>();
  const slots = new Map<number, SlotV1>();
  let composition: 'PENDING' | 'PAID' | 'REFUSED' = 'PENDING';
  let incompleteTransfers = 0;
  let runToken: object | undefined;
  let collected: Readonly<{ analysis: ScanLocalWorklistResultV1; outcome: ScanLocalFlowOutcomeV1 }> | undefined;

  const publish: ScanLocalPublishV1 = (publication, charge) => {
    if (collected !== undefined) throw new TypeError('a collected collector cannot publish');
    if (runToken === undefined) runToken = publication.runToken;
    else if (runToken !== publication.runToken) throw new TypeError('a collector cannot observe a second run');
    const bucket = byKind[KIND_KEY[publication.kind]];
    bucket.atoms += publication.omittedAtoms;
    bucket.tokens += publication.omittedTokens;
    if (publication.kind !== 'TRANSFER') return;
    const requests = bySink.get(publication.node);
    if (requests === undefined) return;
    const { node, state, omittedAtoms, omittedTokens } = publication;
    const generation = (generations.get(node) ?? 0) + 1;
    generations.set(node, generation);
    records.set(node, Object.freeze({ generation, state, omittedAtoms, omittedTokens, complete: false }));
    if (composition === 'PENDING') {
      composition = charge(1 + 3 * prepared.length) ? 'PAID' : 'REFUSED';
    }
    if (composition === 'REFUSED') { incompleteTransfers += 1; return; }
    let evaluationCost = atomKeyCost(state.atoms) + requests.length;
    for (const request of requests) evaluationCost += 1 + request.atom.field.length;
    if (!charge(evaluationCost)) { incompleteTransfers += 1; return; }
    const support = new Set<string>();
    for (const atom of state.atoms) support.add(atomKey(atom));
    let refused = false;
    const candidateCharge: ScanLocalChargeV1 = input.onCandidate === undefined ? charge
      : (units) => { const accepted = charge(units); if (!accepted) refused = true; return accepted; };
    for (const request of requests) {
      const candidate = support.has(atomKey(request.atom))
        ? Object.freeze({ atom: request.atom, sourceNode: request.sourceNode, sinkNode: node,
          sinkState: state, observation: 'TRANSFER_OUTPUT' as const, omittedAtoms, omittedTokens })
        : null;
      if (candidate !== null && input.onCandidate !== undefined) {
        input.onCandidate(candidate, candidateCharge);
        if (refused) { incompleteTransfers += 1; return; }
      }
      slots.set(request.ordinal, Object.freeze({ candidate, generation }));
    }
    records.set(node, Object.freeze({ generation, state, omittedAtoms, omittedTokens, complete: true }));
  };

  const collect = (analysis: ScanLocalWorklistResultV1): ScanLocalFlowOutcomeV1 => {
    if (collected !== undefined) {
      if (collected.analysis === analysis) return collected.outcome;
      throw new TypeError('a collector cannot collect a second analysis');
    }
    const actual = getScanLocalRunToken(analysis);
    if (actual === undefined) throw new TypeError('analysis was not produced by a publish-enabled run');
    if (runToken === undefined) runToken = actual;
    else if (runToken !== actual) throw new TypeError('analysis belongs to a different run');
    const candidates: ScanLocalFlowCandidateV1[] = [];
    let unpublishedSinks = prepared.length;
    let absentAtSinks = 0;
    if (composition === 'PAID') {
      unpublishedSinks = 0;
      for (const request of prepared) {
        const record = records.get(request.sinkNode);
        const slot = slots.get(request.ordinal);
        if (record === undefined || !record.complete || slot === undefined
          || slot.generation !== record.generation) unpublishedSinks += 1;
        else if (slot.candidate === null) absentAtSinks += 1;
        else candidates.push(slot.candidate);
      }
    }
    const composed = composition !== 'REFUSED';
    const omittedAtomsByKind = Object.freeze({
      seed: byKind.seed.atoms, transfer: byKind.transfer.atoms, enqueue: byKind.enqueue.atoms,
    });
    const omittedTokensByKind = Object.freeze({
      seed: byKind.seed.tokens, transfer: byKind.transfer.tokens, enqueue: byKind.enqueue.tokens,
    });
    const outcome: ScanLocalFlowOutcomeV1 = Object.freeze({
      status: analysis.status === 'LIMITED' || !composed || incompleteTransfers > 0
        || invalidRequests > 0 || unmappedSources > 0 || unpublishedSinks > 0
        ? 'LIMITED' : 'COMPLETE',
      fields: analysis.states,
      candidates: Object.freeze(candidates),
      composed,
      omittedAtoms: omittedAtomsByKind.seed + omittedAtomsByKind.transfer + omittedAtomsByKind.enqueue,
      omittedTokens: omittedTokensByKind.seed + omittedTokensByKind.transfer + omittedTokensByKind.enqueue,
      omittedAtomsByKind, omittedTokensByKind,
      invalidRequests, unmappedSources, unpublishedSinks, absentAtSinks, incompleteTransfers,
    });
    collected = Object.freeze({ analysis, outcome });
    return outcome;
  };

  return Object.freeze({ publish, collect });
}

export function isAdmissibleScanLocalFlowRequest(atom: TaintAtomV1, sink: string): boolean {
  return atom.sourceId.length > 0 && sink.length > 0 && atom.channel !== 'CONTROL' && isValidFieldPath(atom.field);
}

export function hasScanLocalAtom(state: FieldStateV1 | undefined, atom: TaintAtomV1, charge: ScanLocalChargeV1): boolean {
  if (state === undefined || state.knowledge !== 'KNOWN') return false;
  for (let index = 0; index < state.atoms.length; index += 1) {
    if (!charge(1)) return false;
    const candidate = state.atoms[index]!;
    if (!charge(candidate.sourceId.length + atom.sourceId.length + 1)) return false;
    if (candidate.sourceId !== atom.sourceId || candidate.channel !== atom.channel || candidate.field.length !== atom.field.length) continue;
    let matches = true;
    for (let field = 0; field < atom.field.length; field += 1) {
      if (!charge(1)) return false;
      const left = candidate.field[field]!; const right = atom.field[field]!;
      if (!charge(left.length + right.length)) return false;
      if (left !== right) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

export function isAdmissibleScanLocalCarrier(step: TaintTraceStepV2 | undefined,
  charge: ScanLocalChargeV1): step is TaintTraceStepV2 {
  return step !== undefined && charge(1 + step.field.length) && validStep(step);
}

export function isValidScanLocalInputRead(read: ScanLocalTerminalInputReadV1 | undefined,
  channel: ScanLocalWitnessChannelV1, atom: TaintAtomV1, sink: string,
  carrier: TaintTraceStepV2 | undefined, charge: ScanLocalChargeV1): boolean {
  return read !== undefined && read.channel === channel && isAdmissibleScanLocalFlowRequest(atom, sink)
    && read.carrier === carrier && carrier !== undefined && carrier.field === read.sinkParameterPath
    && isValidFieldPath(read.path) && samePath(read.path, atom.field, charge);
}

export function isUniqueScanLocalCarrier(key: string, step: TaintTraceStepV2,
  identities: Map<string, string>, charge: ScanLocalChargeV1): boolean {
  if (!charge(1 + step.field.length)) return false;
  const identity = JSON.stringify([step.node, step.field, step.item]);
  const previous = identities.get(identity);
  if (previous !== undefined && previous !== key) return false;
  identities.set(identity, key);
  return true;
}

function samePath(left: readonly string[], right: readonly string[], charge: ScanLocalChargeV1): boolean {
  if (left.length !== right.length || !charge(1 + left.length)) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!charge(left[index]!.length + right[index]!.length + 1) || left[index] !== right[index]) return false;
  }
  return true;
}
