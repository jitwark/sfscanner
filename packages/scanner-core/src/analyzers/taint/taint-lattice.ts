/** Finite taint lattice used by the bounded propagation engine. */
export const TAINT_LABELS = [
  'WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER', 'INBOUND_MESSAGE',
  'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT',
] as const;

export const TAINT_SINK_KINDS = ['SQL', 'COMMAND', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT'] as const;

export type TaintLabel = (typeof TAINT_LABELS)[number];
export type TaintSinkKind = (typeof TAINT_SINK_KINDS)[number];
export type TaintState = {
  readonly labels: ReadonlySet<TaintLabel>;
  readonly sanitizedFor: ReadonlySet<TaintSinkKind>;
};

export const MAX_TAINT_LATTICE_ASCENT = TAINT_LABELS.length + TAINT_SINK_KINDS.length;

/**
 * A taint state is a value: it owns its membership and is frozen, so a holder cannot replace its
 * label/sink collections. Publication detaches states from the caller's seeds and from the shared
 * bottom/top identities, so mutating either afterwards cannot rewrite what a consumer already read.
 */
export function createTaintState(labels: Iterable<TaintLabel>, sanitizedFor: Iterable<TaintSinkKind>): TaintState {
  return Object.freeze({ labels: new Set(labels), sanitizedFor: new Set(sanitizedFor) });
}

export const bottomTaintState: TaintState = createTaintState([], TAINT_SINK_KINDS);
export const topTaintState: TaintState = createTaintState(TAINT_LABELS, []);

export function joinTaintStates(left: TaintState, right: TaintState): TaintState {
  return createTaintState(
    [...left.labels, ...right.labels],
    [...left.sanitizedFor].filter((sink) => right.sanitizedFor.has(sink)),
  );
}

export function isTaintStateAtMost(left: TaintState, right: TaintState): boolean {
  return isSubset(left.labels, right.labels) && isSubset(right.sanitizedFor, left.sanitizedFor);
}

export function taintStatesEqual(left: TaintState, right: TaintState): boolean {
  return isTaintStateAtMost(left, right) && isTaintStateAtMost(right, left);
}

export function isTainted(state: TaintState): boolean {
  return state.labels.size > 0;
}

export function reachesSink(state: TaintState, sink: TaintSinkKind): boolean {
  return isTainted(state) && !state.sanitizedFor.has(sink);
}

export function orderedTaintLabels(state: TaintState): TaintLabel[] {
  return TAINT_LABELS.filter((label) => state.labels.has(label));
}

export function orderedSanitizedSinks(state: TaintState): TaintSinkKind[] {
  return TAINT_SINK_KINDS.filter((sink) => state.sanitizedFor.has(sink));
}

function isSubset<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return [...left].every((value) => right.has(value));
}
