import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

export type GraphOperationBudgetV2 = Readonly<{
  maximum: number;
  used: number;
  omitted: number;
  exhausted: boolean;
}>;

export type GraphOperationBudgetInputV2 =
  | GraphOperationBudgetV2
  | number
  | Readonly<{ maxGraphOperations: number }>;

export type GraphOperationChargeV2 = Readonly<{
  ok: boolean;
  counter: GraphOperationBudgetV2;
}>;

export type PreparedGraphNodeV2 = Readonly<{
  index: number;
  enabled: boolean;
  scoringEligible: boolean;
}>;

export type PreparedGraphEdgeV2 = Readonly<{
  from: number;
  to: number;
  sourcePort: number;
  targetPort: number;
}>;

export type PreparedGraphV2 = Readonly<{
  nodes: readonly PreparedGraphNodeV2[];
  edges: readonly PreparedGraphEdgeV2[];
  outgoing: readonly (readonly number[])[];
  incoming: readonly (readonly number[])[];
}>;

export function createGraphOperationBudget(maximum: number): GraphOperationBudgetV2 {
  requireNonNegativeSafeInteger(maximum, 'maximum');
  return freezeBudget({ maximum, used: 0, omitted: 0, exhausted: false });
}

export function chargeGraphOperation(
  current: GraphOperationBudgetV2,
  units = 1,
): GraphOperationChargeV2 {
  requireBudget(current);
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new TypeError('units must be a positive safe integer');
  }
  if (current.used > current.maximum || current.used > Number.MAX_SAFE_INTEGER - units) {
    throw new TypeError('budget is already exhausted or charge exceeds the safe integer range');
  }
  const used = current.used + units;
  const omitted = Math.max(0, used - current.maximum);
  const counter = freezeBudget({ maximum: current.maximum, used, omitted, exhausted: used > current.maximum });
  return Object.freeze({ ok: !counter.exhausted, counter });
}

export function normalizeGraphOperationBudget(input: GraphOperationBudgetInputV2): GraphOperationBudgetV2 {
  if (typeof input === 'number') return createGraphOperationBudget(input);
  if (plainObject(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'maxGraphOperations');
    if (descriptor && 'value' in descriptor) return createGraphOperationBudget(descriptor.value as number);
  }
  requireBudget(input);
  return freezeBudget({ ...input });
}

export function prepareGraphV2(workflow: SecurityWorkflowV2): PreparedGraphV2 {
  const root = closedObject(workflow, ['workflowFields', 'nodes', 'edges', 'ambiguities'], ['nodes', 'edges']);
  const rawNodes = denseArray(data(root, 'nodes'), 'nodes');
  const nodes: PreparedGraphNodeV2[] = [];
  const ordinals = new Set<number>();
  for (let index = 0; index < rawNodes.length; index += 1) {
    const node = closedObject(rawNodes[index], ['ref', 'type', 'typeVersion', 'disabled', 'scoringEligibility', 'parameters', 'credentials', 'settings'], ['ref', 'disabled', 'scoringEligibility']);
    const ref = closedObject(data(node, 'ref'), ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal']);
    const ordinal = data(ref, 'ordinal');
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal !== index || ordinals.has(ordinal)) throw new TypeError('node ordinals must be dense and unique');
    const disabled = data(node, 'disabled');
    const eligibility = data(node, 'scoringEligibility');
    if (typeof disabled !== 'boolean' || (eligibility !== 'ELIGIBLE' && eligibility !== 'INDETERMINATE')) throw new TypeError('invalid graph node state');
    ordinals.add(ordinal);
    nodes.push(Object.freeze({ index: ordinal, enabled: !disabled, scoringEligible: eligibility === 'ELIGIBLE' }));
  }

  const rawEdges = denseArray(data(root, 'edges'), 'edges');
  const edges: PreparedGraphEdgeV2[] = [];
  const edgeKeys = new Set<string>();
  for (const rawEdge of rawEdges) {
    const edge = closedObject(rawEdge, ['ordinal', 'sourceNode', 'targetNode', 'sourceLabel', 'targetLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution'], ['connectionType', 'sourcePort', 'targetPort', 'resolution']);
    const resolution = data(edge, 'resolution');
    const connectionType = data(edge, 'connectionType');
    const sourcePort = data(edge, 'sourcePort');
    const targetPort = data(edge, 'targetPort');
    if ((resolution !== 'RESOLVED' && resolution !== 'AMBIGUOUS' && resolution !== 'UNRESOLVED') || typeof connectionType !== 'string' || typeof sourcePort !== 'number' || typeof targetPort !== 'number' || !Number.isSafeInteger(sourcePort) || !Number.isSafeInteger(targetPort) || sourcePort < 0 || targetPort < 0) throw new TypeError('invalid graph edge');
    if (resolution !== 'RESOLVED' || connectionType !== 'main') continue;
    const source = closedObject(data(edge, 'sourceNode'), ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal']);
    const target = closedObject(data(edge, 'targetNode'), ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal']);
    const from = data(source, 'ordinal');
    const to = data(target, 'ordinal');
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || from >= nodes.length || to >= nodes.length) throw new TypeError('graph edge is out of range');
    const key = `${from}:${to}:${sourcePort}:${targetPort}`;
    if (edgeKeys.has(key)) throw new TypeError('duplicate graph edge');
    edgeKeys.add(key);
    edges.push(Object.freeze({ from, to, sourcePort, targetPort }));
  }

  const outgoing = nodes.map(() => [] as number[]);
  const incoming = nodes.map(() => [] as number[]);
  for (const edge of edges) {
    outgoing[edge.from].push(edge.to);
    incoming[edge.to].push(edge.from);
  }
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    outgoing: Object.freeze(outgoing.map((list) => Object.freeze(list.slice().sort((left, right) => left - right)))),
    incoming: Object.freeze(incoming.map((list) => Object.freeze(list.slice().sort((left, right) => left - right)))),
  });
}

function closedObject(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!plainObject(value)) throw new TypeError('graph input must be a plain object');
  let names: string[];
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('graph input has symbols');
    names = Object.getOwnPropertyNames(value);
  } catch {
    throw new TypeError('graph input is not data-only');
  }
  for (const name of names) {
    if (!allowed.includes(name)) throw new TypeError(`unknown graph field: ${name}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('graph input has an accessor');
  }
  for (const name of required) if (!names.includes(name)) throw new TypeError(`missing graph field: ${name}`);
  return value;
}

function denseArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${name} must be a plain array`);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key !== 'length' && !/^\d+$/.test(key)) throw new TypeError(`${name} has extra members`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new TypeError(`${name} must be dense data`);
    }
    return value;
  } catch {
    throw new TypeError(`${name} is not a closed array`);
  }
}

function data(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw new TypeError('graph input has an accessor');
  return descriptor.value;
}

function requireBudget(value: unknown): asserts value is GraphOperationBudgetV2 {
  if (!plainObject(value)) throw new TypeError('invalid graph budget');
  for (const key of ['maximum', 'used', 'omitted'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) throw new TypeError('invalid graph budget counter');
  }
  const candidate = value as GraphOperationBudgetV2;
  if (candidate.used > candidate.maximum || candidate.omitted !== Math.max(0, candidate.used - candidate.maximum) || candidate.exhausted !== (candidate.used > candidate.maximum)) throw new TypeError('inconsistent graph budget state');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function freezeBudget(value: GraphOperationBudgetV2): GraphOperationBudgetV2 {
  return Object.freeze(value);
}
