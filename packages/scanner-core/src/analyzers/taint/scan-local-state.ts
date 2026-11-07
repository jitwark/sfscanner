export type TaintChannelV1 = 'CONFIDENTIALITY' | 'INTEGRITY' | 'CONTROL';
export type UnknownReasonV1 =
  | 'UNMODELLED_SOURCE' | 'UNMODELLED_TRANSFER' | 'DYNAMIC_FIELD'
  | 'AMBIGUOUS_EDGE' | 'UNSUPPORTED_SELECTOR' | 'PAYLOAD_LIMIT';

export type TaintAtomV1 = Readonly<{
  sourceId: string;
  field: readonly string[];
  channel: TaintChannelV1;
}>;
export type SanitizerTokenV1 = Readonly<{ modelId: string; sink: string; pathDigest: string }>;
export type FieldStateV1 =
  | Readonly<{ knowledge: 'KNOWN'; atoms: readonly TaintAtomV1[]; unknownReasons: readonly []; sanitizedFor: readonly SanitizerTokenV1[]; omittedSanitizers: number }>
  | Readonly<{ knowledge: 'UNKNOWN'; atoms: readonly TaintAtomV1[]; unknownReasons: readonly [UnknownReasonV1, ...UnknownReasonV1[]]; sanitizedFor: readonly SanitizerTokenV1[]; omittedSanitizers: number }>;

/** Required budget contract: a refusal returns false and performs no corresponding work or debit. */
export type ScanLocalChargeV1 = (units: number) => boolean;
export type ScanLocalBoundResultV1 =
  | Readonly<{ status: 'BOUNDED'; state: FieldStateV1; omittedAtoms: number; omittedTokens: number }>
  | Readonly<{ status: 'BUDGET_EXHAUSTED'; omittedLowerBound: number }>;
export type ScanLocalJoinResultV1 =
  | Readonly<{ status: 'JOINED'; state: FieldStateV1 }>
  | Readonly<{ status: 'BUDGET_EXHAUSTED'; omittedLowerBound: number }>;

export const SCAN_LOCAL_LIMITS_V1 = Object.freeze({
  maxAtomsPerField: 64,
  maxSanitizerTokens: 16,
  maxUnknownReasons: 6,
  maxPathDepth: 32,
  maxSegmentBytes: 256,
  maxFieldStates: 10_000,
});
const REASON_ORDER: readonly UnknownReasonV1[] = Object.freeze([
  'UNMODELLED_SOURCE', 'UNMODELLED_TRANSFER', 'DYNAMIC_FIELD',
  'AMBIGUOUS_EDGE', 'UNSUPPORTED_SELECTOR', 'PAYLOAD_LIMIT',
]);
const encoder = new TextEncoder();

/** Code-unit total order: distinct keys never compare equal, unlike locale collation. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Injective canonical atom identity: a JSON tuple, so no separator can merge two distinct layouts. */
export function atomKey(atom: TaintAtomV1): string {
  return JSON.stringify([atom.channel, atom.sourceId, atom.field]);
}

export function knownState(atoms: readonly TaintAtomV1[] = [], sanitizedFor: readonly SanitizerTokenV1[] = [], omittedSanitizers = 0): FieldStateV1 {
  return assembledState(Object.freeze(dedupeAtoms(atoms)), sanitizedFor, omittedSanitizers);
}
/** Assembles already-deduplicated, already-sorted atoms; only tokens are normalized here. */
function assembledState(atoms: readonly TaintAtomV1[], sanitizedFor: readonly SanitizerTokenV1[], omittedSanitizers: number): FieldStateV1 {
  const tokens = Object.freeze(dedupeTokens(sanitizedFor));
  if (!atoms.every((atom) => isValidFieldPath(atom.field))) {
    return Object.freeze({
      knowledge: 'UNKNOWN', atoms, sanitizedFor: tokens, omittedSanitizers,
      unknownReasons: Object.freeze(['PAYLOAD_LIMIT'] as const),
    });
  }
  return Object.freeze({ knowledge: 'KNOWN', atoms, unknownReasons: Object.freeze([]) as readonly [], sanitizedFor: tokens, omittedSanitizers });
}
export function unknownState(reason: UnknownReasonV1): FieldStateV1 {
  return Object.freeze({ knowledge: 'UNKNOWN', atoms: Object.freeze([]), unknownReasons: Object.freeze([reason] as [UnknownReasonV1]), sanitizedFor: Object.freeze([]), omittedSanitizers: 0 });
}

/** UNKNOWN dominates; reasons and atoms are deterministically ordered and deduplicated. Charged before any merge. */
export function joinFieldStates(left: FieldStateV1, right: FieldStateV1, charge: ScanLocalChargeV1): ScanLocalJoinResultV1 {
  if (!charge(joinCost(left, right))) return { status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 };
  const atoms = dedupeAtoms([...left.atoms, ...right.atoms]);
  const rightKeys = new Set(right.sanitizedFor.map(tokenKey));
  const sanitizedFor = left.sanitizedFor.filter((token) => rightKeys.has(tokenKey(token))).slice(0, SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens);
  const omittedSanitizers = Math.max(left.omittedSanitizers, right.omittedSanitizers);
  if (left.knowledge === 'KNOWN' && right.knowledge === 'KNOWN') {
    return { status: 'JOINED', state: assembledState(Object.freeze(atoms), sanitizedFor, omittedSanitizers) };
  }
  const reasons = REASON_ORDER.filter((reason) =>
    [...left.unknownReasons, ...right.unknownReasons].includes(reason)).slice(0, SCAN_LOCAL_LIMITS_V1.maxUnknownReasons);
  return {
    status: 'JOINED',
    state: Object.freeze({
      knowledge: 'UNKNOWN', atoms: Object.freeze(atoms), sanitizedFor: Object.freeze(sanitizedFor), omittedSanitizers,
      unknownReasons: Object.freeze(reasons.length === 0 ? ['UNMODELLED_TRANSFER'] : reasons) as readonly [UnknownReasonV1, ...UnknownReasonV1[]],
    }),
  };
}

/** A reviewed unconditional overwrite may kill prior provenance; anything else widens to UNKNOWN. */
export function overwriteFieldState(prior: FieldStateV1, replacement: FieldStateV1, exact: boolean, charge: ScanLocalChargeV1): ScanLocalJoinResultV1 {
  if (!exact) return joinFieldStates(prior, unknownState('DYNAMIC_FIELD'), charge);
  return { status: 'JOINED', state: replacement };
}

export function sanitizeFieldState(state: FieldStateV1, token: SanitizerTokenV1): FieldStateV1 {
  const key = tokenKey(token);
  if (state.sanitizedFor.some((existing) => tokenKey(existing) === key)) return state;
  if (state.sanitizedFor.length >= SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens) {
    return Object.freeze({ ...state, omittedSanitizers: state.omittedSanitizers + 1 });
  }
  const tokens = dedupeTokens([...state.sanitizedFor, token]);
  return Object.freeze({ ...state, sanitizedFor: Object.freeze(tokens) });
}

/** Charges every atom and token it inspects; a refusal yields no state and a positive omission lower bound. */
export function boundFieldState(state: FieldStateV1, charge: ScanLocalChargeV1): ScanLocalBoundResultV1 {
  if (!charge(1)) return { status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 };
  const totalAtoms = state.atoms.length;
  const kept: TaintAtomV1[] = [];
  for (let index = 0; index < totalAtoms; index += 1) {
    // One unit covers the atom read and its path check, which is bounded by the depth and segment caps.
    if (!charge(1)) return { status: 'BUDGET_EXHAUSTED', omittedLowerBound: totalAtoms - index };
    const candidate = state.atoms[index]!;
    if (isValidFieldPath(candidate.field) && kept.length < SCAN_LOCAL_LIMITS_V1.maxAtomsPerField) kept.push(candidate);
  }
  if (!charge(1)) return { status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 };
  const omittedAtoms = totalAtoms - kept.length;
  const omittedTokens = state.omittedSanitizers + Math.max(0, state.sanitizedFor.length - SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens);
  if (omittedAtoms === 0 && omittedTokens === 0) return { status: 'BOUNDED', state, omittedAtoms: 0, omittedTokens: 0 };
  if (!charge(1)) return { status: 'BUDGET_EXHAUSTED', omittedLowerBound: 1 + omittedAtoms + omittedTokens };
  const present: readonly UnknownReasonV1[] = [...state.unknownReasons, 'PAYLOAD_LIMIT'];
  const reasons = REASON_ORDER.filter((reason) => present.includes(reason)).slice(0, SCAN_LOCAL_LIMITS_V1.maxUnknownReasons);
  return {
    status: 'BOUNDED',
    state: Object.freeze({
      knowledge: 'UNKNOWN', atoms: Object.freeze(kept),
      sanitizedFor: Object.freeze(state.sanitizedFor.slice(0, SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens)), omittedSanitizers: 0,
      unknownReasons: Object.freeze(reasons) as readonly [UnknownReasonV1, ...UnknownReasonV1[]],
    }),
    omittedAtoms, omittedTokens,
  };
}

export function isValidFieldPath(path: readonly string[]): boolean {
  if (path.length > SCAN_LOCAL_LIMITS_V1.maxPathDepth) return false;
  // UTF-8 bytes are never fewer than UTF-16 code units, so reject overlong input without encoding it.
  return path.every((segment) => segment.length <= SCAN_LOCAL_LIMITS_V1.maxSegmentBytes
    && encoder.encode(segment).length <= SCAN_LOCAL_LIMITS_V1.maxSegmentBytes);
}

/** Deduplicates and totally orders atoms, keying each atom once and sorting by that key alone. */
function dedupeAtoms(atoms: readonly TaintAtomV1[]): TaintAtomV1[] {
  const seen = new Set<string>();
  const keyed: { key: string; atom: TaintAtomV1 }[] = [];
  for (const atom of atoms) {
    const key = atomKey(atom);
    if (seen.has(key)) continue;
    seen.add(key);
    keyed.push({ key, atom });
  }
  return keyed.sort((left, right) => compareCodeUnits(left.key, right.key)).map(({ atom }) => atom);
}
function tokenKey(token: SanitizerTokenV1): string { return JSON.stringify([token.modelId, token.sink, token.pathDigest]); }
/** Conservative precharge: atom merge/dedupe/sort + validation, token intersection/dedupe/sort, reasons, envelope. */
function joinCost(left: FieldStateV1, right: FieldStateV1): number {
  const atoms = left.atoms.length + right.atoms.length;
  const tokens = left.sanitizedFor.length + right.sanitizedFor.length;
  const reasons = left.unknownReasons.length + right.unknownReasons.length;
  const atomSort = atoms > 1 ? Math.ceil(atoms * Math.log2(atoms)) : 0;
  const tokenSort = tokens > 1 ? Math.ceil(tokens * Math.log2(tokens)) : 0;
  return 1 + 2 * atoms + atomSort + 2 * tokens + tokenSort + reasons;
}
function dedupeTokens(tokens: readonly SanitizerTokenV1[]): SanitizerTokenV1[] {
  const seen = new Set<string>();
  const keyed: { key: string; token: SanitizerTokenV1 }[] = [];
  for (const token of tokens) {
    const key = tokenKey(token);
    if (seen.has(key)) continue;
    seen.add(key);
    keyed.push({ key, token });
  }
  return keyed.sort((left, right) => compareCodeUnits(left.key, right.key)).map(({ token }) => token);
}
