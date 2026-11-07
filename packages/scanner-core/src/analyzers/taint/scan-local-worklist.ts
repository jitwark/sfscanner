import {
  SCAN_LOCAL_LIMITS_V1, boundFieldState, compareCodeUnits, joinFieldStates, unknownState,
  type FieldStateV1, type ScanLocalChargeV1,
} from './scan-local-state';

export type ScanLocalWitnessEventV1 =
  | Readonly<{ kind: 'TRANSFER'; node: string; input: FieldStateV1; output: FieldStateV1 }>
  | Readonly<{ kind: 'PROPAGATION'; from: string; to: string; output: FieldStateV1 }>;

export type ScanLocalPublishedStateV1 = Readonly<{
  kind: 'SEED' | 'TRANSFER' | 'ENQUEUE';
  node: string;
  state: FieldStateV1;
  /** Exact bound result for this value; never inferred from the worklist's mixed omission total. */
  omittedAtoms: number;
  omittedTokens: number;
}>;
/** The public publication view plus the frozen identity of the run that produced it. */
type ScanLocalPublicationEventV1 = ScanLocalPublishedStateV1 & Readonly<{ runToken: object }>;
export type ScanLocalPublishV1 = (publication: ScanLocalPublicationEventV1, charge: ScanLocalChargeV1) => void;

export type ScanLocalWorklistInputV1 = Readonly<{
  entry: string;
  graph: ReadonlyMap<string, readonly string[]>;
  transfer: (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1;
  initialState: FieldStateV1;
  maxStates: number;
  maxOperations?: number;
  charge?: ScanLocalChargeV1;
  observe?: (event: ScanLocalWitnessEventV1, charge: ScanLocalChargeV1) => void;
  publish?: ScanLocalPublishV1;
  finish?: (charge: ScanLocalChargeV1) => number;
}>;
export type ScanLocalWorklistResultV1 = Readonly<{
  status: 'COMPLETE' | 'LIMITED';
  states: ReadonlyMap<string, FieldStateV1>;
  queuePops: number;
  joins: number;
  omitted: number;
}>;

/** Publish-enabled results carry one frozen run token out of band; the public result shape never changes. */
const RUN_TOKENS = new WeakMap<ScanLocalWorklistResultV1, object>();
/** The single run identity of a publish-enabled result, or undefined for a hook-free run. */
export function getScanLocalRunToken(result: ScanLocalWorklistResultV1): object | undefined { return RUN_TOKENS.get(result); }
function bindRunToken(result: ScanLocalWorklistResultV1, runToken: object | undefined): ScanLocalWorklistResultV1 {
  if (runToken !== undefined) RUN_TOKENS.set(result, runToken);
  return result;
}

/** Stable queue order, monotone joins, and hard state/operation caps. Every budgeted step is charged first. */
export function runScanLocalWorklist(input: ScanLocalWorklistInputV1): ScanLocalWorklistResultV1 {
  if (!Number.isSafeInteger(input.maxStates) || input.maxStates < 1) throw new TypeError('maxStates must be a positive safe integer');
  const maxStates = Math.min(input.maxStates, SCAN_LOCAL_LIMITS_V1.maxFieldStates);
  const maxOperations = input.maxOperations ?? maxStates * 8;
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) throw new TypeError('maxOperations must be a positive safe integer');
  const runToken = input.publish === undefined ? undefined : Object.freeze({});
  const states = new Map<string, FieldStateV1>();
  const propagatedOutputs = new Map<string, FieldStateV1>();
  const queue: string[] = [input.entry];
  const queued = new Set<string>([input.entry]);
  let payloadOmitted = 0;
  let queuePops = 0;
  let joins = 0;
  let operations = 0;
  const limited = (omitted: number, limit = maxStates): ScanLocalWorklistResultV1 => bindRunToken(Object.freeze({
    status: 'LIMITED', states: immutableStates(states, limit), queuePops, joins,
    omitted: omitted + payloadOmitted,
  }), runToken);
  const charge: ScanLocalChargeV1 = input.charge ?? ((units) => {
    if (!Number.isSafeInteger(units) || units < 0) throw new TypeError('charge units must be a non-negative safe integer');
    if (units > maxOperations - operations) return false;
    operations += units;
    return true;
  });
  let transferRefused = false;
  const transferCharge: ScanLocalChargeV1 = (units) => {
    if (transferRefused) return false;
    const accepted = charge(units);
    if (!accepted) transferRefused = true;
    return accepted;
  };
  const observe = (event: ScanLocalWitnessEventV1): boolean => {
    if (input.observe === undefined) return true;
    if (!charge(1)) return false;
    transferRefused = false;
    input.observe(Object.freeze(event), transferCharge);
    return !transferRefused;
  };
  const publish: ScanLocalPublishStateFnV1 = (kind, node, state, omittedAtoms, omittedTokens) => {
    if (input.publish === undefined) return true;
    if (!charge(1)) return false;
    transferRefused = false;
    input.publish(Object.freeze({ kind, node, state, omittedAtoms, omittedTokens, runToken: runToken! }), transferCharge);
    return !transferRefused;
  };
  /** A refused seed is never clean: only an UNKNOWN/PAYLOAD_LIMIT state without taint payload is published. */
  const seeded = (omitted: number): ScanLocalWorklistResultV1 => {
    states.set(input.entry, unknownState('PAYLOAD_LIMIT'));
    return limited(Math.max(1, omitted));
  };
  if (!charge(1)) return seeded(1);
  const initial = boundFieldState(input.initialState, charge);
  if (initial.status === 'BUDGET_EXHAUSTED') return seeded(initial.omittedLowerBound);
  payloadOmitted += initial.omittedAtoms + initial.omittedTokens;
  if (!charge(1)) return seeded(1);
  if (!publish('SEED', input.entry, initial.state, initial.omittedAtoms, initial.omittedTokens)) return seeded(1);
  states.set(input.entry, initial.state);
  while (queue.length > 0) {
    if (!charge(1)) return limited(queue.length);
    const node = queue.shift()!;
    queued.delete(node);
    queuePops += 1;
    const current = states.get(node);
    if (current === undefined) continue;
    if (!charge(1)) return limited(queue.length + 1);
    transferRefused = false;
    const transferred = input.transfer(node, current, transferCharge);
    if (transferRefused) return limited(queue.length + 1);
    const bounded = boundFieldState(transferred, charge);
    if (bounded.status === 'BUDGET_EXHAUSTED') return limited(queue.length + 1 + bounded.omittedLowerBound);
    payloadOmitted += bounded.omittedAtoms + bounded.omittedTokens;
    const next = bounded.state;
    if (!publish('TRANSFER', node, next, bounded.omittedAtoms, bounded.omittedTokens)) return limited(queue.length + 1);
    if (!observe({ kind: 'TRANSFER', node, input: current, output: next })) return limited(queue.length + 1);
    if (!charge(stateWeight(current) + stateWeight(next))) return limited(queue.length + 1);
    const changed = !sameState(next, current);
    if (changed) {
      if (!charge(1)) return limited(queue.length + 1);
      joins += 1;
      states.set(node, next);
    }
    if (states.size > maxStates) return limited(states.size - maxStates + queue.length);
    const priorOutput = propagatedOutputs.get(node);
    if (priorOutput !== undefined) {
      if (!charge(stateWeight(priorOutput) + stateWeight(next))) return limited(queue.length + 1);
      if (sameState(priorOutput, next)) continue;
    }
    if (!charge(1)) return limited(queue.length + 1);
    propagatedOutputs.set(node, next);
    const adjacency = input.graph.get(node);
    const targetCount = adjacency === undefined ? 0 : adjacency.length;
    const remaining = input.charge === undefined ? maxOperations - operations : undefined;
    if (remaining !== undefined && targetCount > remaining) return limited(queue.length + targetCount);
    const targets: string[] = [];
    for (let index = 0; index < targetCount; index += 1) {
      if (!charge(1)) return limited(queue.length + targetCount - index);
      targets.push(adjacency![index]!);
    }
    const sortCost = targetCount > 1 ? Math.ceil(targetCount * Math.log2(targetCount)) : 0;
    if (!charge(sortCost)) return limited(queue.length + targetCount);
    targets.sort(compareCodeUnits);
    for (const target of targets) {
      if (!charge(1)) return limited(queue.length + targets.length);
      const joined = enqueue(target, next, states, queue, queued, charge, publish);
      if (joined.status === 'REFUSED') return limited(joined.omittedLowerBound + queue.length + targets.length);
      payloadOmitted += joined.omittedAtoms + joined.omittedTokens;
      if (states.size > maxStates) return limited(states.size - maxStates + queue.length);
      if (!observe({ kind: 'PROPAGATION', from: node, to: target, output: next })) return limited(queue.length + 1);
    }
  }
  if (input.finish !== undefined) {
    transferRefused = false;
    const omitted = input.finish(transferCharge);
    if (!Number.isSafeInteger(omitted) || omitted < 0) throw new TypeError('Witness omissions must be a non-negative safe integer');
    if (transferRefused) return limited(Math.max(1, omitted));
    payloadOmitted += omitted;
  }
  return bindRunToken(Object.freeze({
    status: payloadOmitted > 0 ? 'LIMITED' : 'COMPLETE', states: immutableStates(states), queuePops, joins, omitted: payloadOmitted,
  }), runToken);
}

type ScanLocalPublishStateFnV1 = (kind: ScanLocalPublishedStateV1['kind'], node: string, state: FieldStateV1, omittedAtoms: number, omittedTokens: number) => boolean;
type ScanLocalEnqueueResultV1 = Readonly<{ status: 'ENQUEUED'; omittedAtoms: number; omittedTokens: number }> | Readonly<{ status: 'REFUSED'; omittedLowerBound: number }>;
/** Joins, bounds and commits one target only after every unit of that work is affordable. */
function enqueue(target: string, state: FieldStateV1, states: Map<string, FieldStateV1>, queue: string[], queued: Set<string>, charge: ScanLocalChargeV1, publish: ScanLocalPublishStateFnV1): ScanLocalEnqueueResultV1 {
  const prior = states.get(target);
  let next = state;
  let omittedAtoms = 0;
  let omittedTokens = 0;
  if (prior === undefined) {
    const bounded = boundFieldState(state, charge);
    if (bounded.status === 'BUDGET_EXHAUSTED') return { status: 'REFUSED', omittedLowerBound: bounded.omittedLowerBound };
    next = bounded.state;
    omittedAtoms = bounded.omittedAtoms; omittedTokens = bounded.omittedTokens;
  } else {
    const joined = joinFieldStates(prior, state, charge);
    if (joined.status === 'BUDGET_EXHAUSTED') return { status: 'REFUSED', omittedLowerBound: joined.omittedLowerBound };
    if (!charge(stateWeight(prior) + stateWeight(joined.state))) return { status: 'REFUSED', omittedLowerBound: 1 };
    if (sameState(prior, joined.state)) return { status: 'ENQUEUED', omittedAtoms: 0, omittedTokens: 0 };
    const bounded = boundFieldState(joined.state, charge);
    if (bounded.status === 'BUDGET_EXHAUSTED') return { status: 'REFUSED', omittedLowerBound: bounded.omittedLowerBound };
    next = bounded.state;
    omittedAtoms = bounded.omittedAtoms; omittedTokens = bounded.omittedTokens;
  }
  const commitCost = queued.has(target) ? 1 : 2;
  if (!charge(commitCost)) return { status: 'REFUSED', omittedLowerBound: 1 };
  if (!publish('ENQUEUE', target, next, omittedAtoms, omittedTokens)) return { status: 'REFUSED', omittedLowerBound: 1 };
  states.set(target, next);
  if (commitCost === 2) { queued.add(target); queue.push(target); }
  return { status: 'ENQUEUED', omittedAtoms, omittedTokens };
}

function stateWeight(state: FieldStateV1): number {
  return state.atoms.length + state.unknownReasons.length + state.sanitizedFor.length + 1;
}

function sameState(left: FieldStateV1, right: FieldStateV1): boolean {
  if (left.knowledge !== right.knowledge || left.atoms.length !== right.atoms.length
    || left.unknownReasons.length !== right.unknownReasons.length
    || left.sanitizedFor.length !== right.sanitizedFor.length
    || left.omittedSanitizers !== right.omittedSanitizers) return false;
  for (let index = 0; index < left.atoms.length; index += 1) {
    const a = left.atoms[index]!; const b = right.atoms[index]!;
    if (a.channel !== b.channel || a.sourceId !== b.sourceId || a.field.length !== b.field.length) return false;
    for (let segment = 0; segment < a.field.length; segment += 1) if (a.field[segment] !== b.field[segment]) return false;
  }
  for (let index = 0; index < left.unknownReasons.length; index += 1) if (left.unknownReasons[index] !== right.unknownReasons[index]) return false;
  for (let index = 0; index < left.sanitizedFor.length; index += 1) {
    const a = left.sanitizedFor[index]!; const b = right.sanitizedFor[index]!;
    if (a.modelId !== b.modelId || a.sink !== b.sink || a.pathDigest !== b.pathDigest) return false;
  }
  return true;
}

/** Publication view over already-admitted states, bounded by the state cap and required to render refusals. */
function immutableStates(states: Map<string, FieldStateV1>, limit = Number.POSITIVE_INFINITY): ReadonlyMap<string, FieldStateV1> {
  const map = new Map([...states.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .slice(0, limit));
  const view = {
    get size() { return map.size; },
    has(key: string) { return map.has(key); },
    get(key: string) { return map.get(key); },
    entries() { return map.entries(); },
    keys() { return map.keys(); },
    values() { return map.values(); },
    forEach(callback: (value: FieldStateV1, key: string) => void) { map.forEach((value, key) => callback(value, key)); },
    [Symbol.iterator]() { return map[Symbol.iterator](); },
  };
  return Object.freeze(view as unknown as ReadonlyMap<string, FieldStateV1>);
}
