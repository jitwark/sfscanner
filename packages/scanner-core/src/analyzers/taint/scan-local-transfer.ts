import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '../../canonical-json';
import { FIELD_FLOW_ENUMS_V1, FIELD_FLOW_SANITIZER_MODELS_V1 } from '../../../../../contracts/scanner-v2-field-flow';
import { fieldFlowPathDigestV1 } from '../../../../../contracts/scanner-v2-field-flow-validation';
import {
  SCAN_LOCAL_LIMITS_V1, isValidFieldPath, joinFieldStates, knownState, sanitizeFieldState, unknownState,
  type FieldStateV1, type ScanLocalChargeV1, type TaintChannelV1, type UnknownReasonV1,
} from './scan-local-state';

export type DataflowSinkClassV3 = (typeof FIELD_FLOW_ENUMS_V1.sinkClass)[number];
export type FieldTransferModelV1 =
  | Readonly<{ kind: 'SOURCE'; sourceId: string; field: readonly string[]; channel: TaintChannelV1 }>
  | Readonly<{ kind: 'EXACT_LITERAL' }>
  | Readonly<{ kind: 'COPY' }>
  | Readonly<{ kind: 'MERGE' }>
  | Readonly<{ kind: 'UNKNOWN'; reason: UnknownReasonV1 }>
  | Readonly<{ kind: 'SANITIZE'; calleesOutermostFirst: readonly string[]; binding: 'REVIEWED' | 'SHADOWED' | 'REASSIGNED'; sink: DataflowSinkClassV3; path: readonly string[] }>;

/** The same immutable reviewed authority used by field-flow transport validation. */
export const SCAN_LOCAL_SANITIZER_REGISTRY_V1 = FIELD_FLOW_SANITIZER_MODELS_V1;
const BY_CALLEE = Object.freeze(Object.fromEntries(SCAN_LOCAL_SANITIZER_REGISTRY_V1.map((entry) => [entry.callee, entry])));
const encoder = new TextEncoder();
export const SCAN_LOCAL_SANITIZER_REGISTRY_DIGEST_V1 = bytesToHex(sha256(encoder.encode(canonicalizeJson(SCAN_LOCAL_SANITIZER_REGISTRY_V1))));
const EMPTY = knownState();
const UNKNOWN: Readonly<Record<UnknownReasonV1, FieldStateV1>> = Object.freeze({
  UNMODELLED_SOURCE: unknownState('UNMODELLED_SOURCE'), UNMODELLED_TRANSFER: unknownState('UNMODELLED_TRANSFER'),
  DYNAMIC_FIELD: unknownState('DYNAMIC_FIELD'), AMBIGUOUS_EDGE: unknownState('AMBIGUOUS_EDGE'),
  UNSUPPORTED_SELECTOR: unknownState('UNSUPPORTED_SELECTOR'), PAYLOAD_LIMIT: unknownState('PAYLOAD_LIMIT'),
});

function widen(state: FieldStateV1, reason: UnknownReasonV1, charge: ScanLocalChargeV1): FieldStateV1 {
  const joined = joinFieldStates(state, UNKNOWN[reason], charge);
  return joined.status === 'JOINED' ? joined.state : state;
}
/** Charge before inspecting bounded path text or computing a token identity. */
function admitPath(path: readonly string[], charge: ScanLocalChargeV1): boolean {
  if (path.length > SCAN_LOCAL_LIMITS_V1.maxPathDepth) return false;
  for (let index = 0; index < path.length; index += 1) {
    if (!charge(1)) return false;
    const segment = path[index]!;
    if (segment.length > SCAN_LOCAL_LIMITS_V1.maxSegmentBytes || !charge(segment.length)) return false;
  }
  return isValidFieldPath(path);
}

function sanitize(model: Extract<FieldTransferModelV1, { kind: 'SANITIZE' }>, state: FieldStateV1, charge: ScanLocalChargeV1): FieldStateV1 {
  if (model.binding !== 'REVIEWED') return widen(state, 'UNMODELLED_TRANSFER', charge);
  if (!admitPath(model.path, charge)) return widen(state, 'PAYLOAD_LIMIT', charge);
  if (!charge(SCAN_LOCAL_SANITIZER_REGISTRY_V1.length + 7)) return state;
  const callee = model.calleesOutermostFirst[0];
  if (callee === undefined || !Object.hasOwn(BY_CALLEE, callee)) return widen(state, 'UNMODELLED_TRANSFER', charge);
  const entry = BY_CALLEE[callee]!;
  // Only this field value changes: an outer wrapper cannot inherit an inner wrapper's authority.
  const value = state.sanitizedFor.length === 0 ? state : Object.freeze({ ...state, sanitizedFor: EMPTY.sanitizedFor });
  if (!entry.clears.some((sink) => sink === model.sink)) return value;
  const pathDigest = fieldFlowPathDigestV1(model.path);
  return sanitizeFieldState(value, Object.freeze({ modelId: entry.modelId, sink: model.sink, pathDigest }));
}

/**
 * Internal reviewed-model adapter, not a caller-supplied authority boundary. Each graph key denotes
 * one carrier field; COPY/MERGE receive the worklist's already-joined input for that field. Graph/model
 * resolution and source-label admission belong to the producer. Always use the worklist's latched charge.
 */
export function createScanLocalTransfer(models: ReadonlyMap<string, FieldTransferModelV1>): (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1 {
  return (node, state, charge) => {
    if (!charge(1)) return state;
    const model = models.get(node);
    if (model === undefined) return widen(state, 'UNMODELLED_TRANSFER', charge);
    if (model.kind === 'COPY' || model.kind === 'MERGE') return state;
    if (model.kind === 'EXACT_LITERAL') return EMPTY;
    if (model.kind === 'UNKNOWN') return widen(state, model.reason, charge);
    if (model.kind === 'SANITIZE') return sanitize(model, state, charge);
    if (model.channel === 'CONTROL') return widen(state, 'UNMODELLED_SOURCE', charge);
    if (!admitPath(model.field, charge)) return widen(state, 'PAYLOAD_LIMIT', charge);
    if (!charge(1)) return state;
    const generated = knownState([Object.freeze({ sourceId: model.sourceId, field: Object.freeze([...model.field]), channel: model.channel })]);
    const joined = joinFieldStates(state, generated, charge);
    return joined.status === 'JOINED' ? joined.state : state;
  };
}
