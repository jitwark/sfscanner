export const CONFIDENTIALITY_LABELS = Object.freeze([
  'WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER', 'INBOUND_MESSAGE',
  'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT',
] as const);

export const INTEGRITY_LABELS = Object.freeze([
  'INBOUND_MESSAGE', 'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT',
  'MODEL_OUTPUT', 'RETRIEVED_CONTEXT', 'TOOL_RESULT',
] as const);

export type ConfidentialityLabel = (typeof CONFIDENTIALITY_LABELS)[number];
export type IntegrityLabel = (typeof INTEGRITY_LABELS)[number];
export type LabelState<L extends string> = Readonly<{ labels: readonly L[]; unknown: boolean }>;
export type ConfidentialityState = LabelState<ConfidentialityLabel>;
export type IntegrityState = LabelState<IntegrityLabel>;

function state<L extends string>(order: readonly L[], labels: Iterable<L>, unknown: boolean): LabelState<L> {
  const selected = new Set<L>();
  for (const label of labels) {
    if (!order.includes(label)) throw new TypeError(`unknown taint label: ${String(label)}`);
    selected.add(label);
  }
  return Object.freeze({ labels: Object.freeze(order.filter((label) => selected.has(label))), unknown: unknown === true });
}

function join<L extends string>(order: readonly L[], left: LabelState<L>, right: LabelState<L>): LabelState<L> {
  return state(order, [...left.labels, ...right.labels], left.unknown || right.unknown);
}

function kill<L extends string>(order: readonly L[], value: LabelState<L>, labels: Iterable<L>): LabelState<L> {
  const removed = new Set(labels);
  for (const label of removed) if (!order.includes(label)) throw new TypeError(`unknown taint label: ${String(label)}`);
  return state(order, value.labels.filter((label) => !removed.has(label)), value.unknown);
}

export const bottomConfidentiality: ConfidentialityState = state(CONFIDENTIALITY_LABELS, [], false);
export const unknownConfidentiality: ConfidentialityState = state(CONFIDENTIALITY_LABELS, [], true);
export const bottomIntegrity: IntegrityState = state(INTEGRITY_LABELS, [], false);
export const unknownIntegrity: IntegrityState = state(INTEGRITY_LABELS, [], true);

export function createConfidentialityState(labels: Iterable<ConfidentialityLabel> = [], unknown = false): ConfidentialityState {
  return state(CONFIDENTIALITY_LABELS, labels, unknown);
}
export function createIntegrityState(labels: Iterable<IntegrityLabel> = [], unknown = false): IntegrityState {
  return state(INTEGRITY_LABELS, labels, unknown);
}
export function joinConfidentialityStates(left: ConfidentialityState, right: ConfidentialityState): ConfidentialityState {
  return join(CONFIDENTIALITY_LABELS, left, right);
}
export function joinIntegrityStates(left: IntegrityState, right: IntegrityState): IntegrityState {
  return join(INTEGRITY_LABELS, left, right);
}
export function killConfidentialityLabels(value: ConfidentialityState, labels: Iterable<ConfidentialityLabel>): ConfidentialityState {
  return kill(CONFIDENTIALITY_LABELS, value, labels);
}
export function killIntegrityLabels(value: IntegrityState, labels: Iterable<IntegrityLabel>): IntegrityState {
  return kill(INTEGRITY_LABELS, value, labels);
}
export function isConfidentialityTainted(value: ConfidentialityState): boolean { return value.unknown || value.labels.length > 0; }
export function isIntegrityTainted(value: IntegrityState): boolean { return value.unknown || value.labels.length > 0; }
export function isConfidentialityClean(value: ConfidentialityState): boolean { return !isConfidentialityTainted(value); }
export function isIntegrityClean(value: IntegrityState): boolean { return !isIntegrityTainted(value); }
export function taintStateKey(value: LabelState<string>): string { return `${value.unknown ? 'U' : 'K'}:${value.labels.join(',')}`; }

export const CONFIDENTIALITY_LATTICE = Object.freeze({ labels: CONFIDENTIALITY_LABELS, bottom: bottomConfidentiality, unknown: unknownConfidentiality, join: joinConfidentialityStates });
export const INTEGRITY_LATTICE = Object.freeze({ labels: INTEGRITY_LABELS, bottom: bottomIntegrity, unknown: unknownIntegrity, join: joinIntegrityStates });
export function isConfidentialityStateAtMost(left: ConfidentialityState, right: ConfidentialityState): boolean {
  return left.labels.every((label) => right.labels.includes(label)) && (!left.unknown || right.unknown);
}
export function isIntegrityStateAtMost(left: IntegrityState, right: IntegrityState): boolean {
  return left.labels.every((label) => right.labels.includes(label)) && (!left.unknown || right.unknown);
}
export function confidentialityStatesEqual(left: ConfidentialityState, right: ConfidentialityState): boolean {
  return isConfidentialityStateAtMost(left, right) && isConfidentialityStateAtMost(right, left);
}
export function integrityStatesEqual(left: IntegrityState, right: IntegrityState): boolean {
  return isIntegrityStateAtMost(left, right) && isIntegrityStateAtMost(right, left);
}
