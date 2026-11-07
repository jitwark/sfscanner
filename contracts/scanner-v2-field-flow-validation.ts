import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  FIELD_FLOW_ENUMS_V1 as ENUMS, FIELD_FLOW_PROPERTY_TYPES_V1, FIELD_FLOW_REQUIRED_PROPERTIES_V1,
  FIELD_FLOW_LABELS_BY_CHANNEL_V1, FIELD_FLOW_SANITIZER_MODELS_V1, isFieldFlowFactKindV1, type FieldFlowPropertyTypeV1,
} from './scanner-v2-field-flow';

export const SAFE_FACT_SECRET_PATTERN = /\bsecureflow[-_ ]?token\b|\b(?:sk[-_]?(?:live|test|proj)[-_][\w-]+|AIza[\w-]{35}|AKIA[0-9A-Z]{16}|eyJ[\w-]{12,}\.[\w-]{8,}|(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer(?:[ _-]*token)?|basic[ _-]*auth|access[ _-]*(?:key|token)|token)\s*[:=]\s*[^\s,;]+|[A-Za-z][\w-]*(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer(?:[ _-]*token)?|basic[ _-]*auth|access[ _-]*(?:key|token))\s*[:=])/i;
export const SAFE_FACT_PATH_PATTERN = /(?:^|[/\\])\.\.(?:[/\\]|$)|^(?:[/\\]|~[/\\]|[A-Za-z]:[/\\]|\\\\)/;
export const SAFE_FACT_PROSE_PATTERN = /\b(?:source\s+(?:code|snippet|prose|text)|snippet\s+(?:code|prose|text))\b|\b(?:source|snippet)\s*[:=]|(?:https?|ftp):\/\/|\bAuthorization\s*:|\b(?:DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|SELECT\s+.+\s+FROM)\b/i;
const DIGEST = /^[0-9a-f]{64}$/;
const ENCODER = new TextEncoder();
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const member = (value: unknown, choices: readonly string[]): value is string => typeof value === 'string' && choices.includes(value);
const INTEGER_PROPERTY_TYPE = 'INTEGER';
export type FieldFlowPropertiesV1 = Readonly<Record<string, string | number | readonly string[]>>;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return;
  const names = Reflect.ownKeys(value);
  if (names.length > 64 || names.some((name) => typeof name !== 'string')) return;
  const result: RecordValue = Object.create(null);
  for (const name of names as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) return;
    result[name] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !integer(length.value) || length.value > maximum) return;
  const names = Reflect.ownKeys(value);
  if (names.length !== length.value + 1) return;
  const result: unknown[] = [];
  for (let i = 0; i < length.value; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) return;
    result.push(descriptor.value);
  }
  return result;
}
function ordered(value: unknown, choices: readonly string[], minimum = 0): value is string[] {
  const items = list(value, choices.length);
  if (!items || items.length < minimum) return false;
  let previous = -1;
  for (const item of items) {
    if (typeof item !== 'string') return false;
    const index = choices.indexOf(item);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}
export function isSafeFieldFlowSegmentV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && ENCODER.encode(value).length <= 256 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    && !SAFE_FACT_SECRET_PATTERN.test(value) && !SAFE_FACT_PATH_PATTERN.test(value) && !SAFE_FACT_PROSE_PATTERN.test(value);
}
function fieldPath(value: unknown): value is string[] {
  const parts = list(value, 32);
  return parts !== undefined && parts.every(isSafeFieldFlowSegmentV1);
}
function pointer(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || ENCODER.encode(value).length > 2048) return false;
  if (value === '') return true;
  return value.startsWith('/') && value.slice(1).split('/').every((segment) =>
    !/~(?:[^01]|$)/.test(segment) && isSafeFieldFlowSegmentV1(segment.replace(/~1/g, '/').replace(/~0/g, '~')));
}
function labels(properties: RecordValue): boolean {
  const channel = properties.taintChannel;
  const allowed = channel === 'CONFIDENTIALITY' || channel === 'INTEGRITY' ? FIELD_FLOW_LABELS_BY_CHANNEL_V1[channel] : [];
  return ordered(properties.taintLabels, allowed, 1);
}
export function fieldFlowPathDigestV1(path: readonly string[]): string {
  // Canonical JSON sorts these exact keys as path, schemaVersion; preserve that order.
  return bytesToHex(sha256(ENCODER.encode(JSON.stringify({ path, schemaVersion: 'sanitizer-path-v1' }))));
}
function tokens(properties: RecordValue): boolean {
  const items = list(properties.sanitizedFor, 16);
  if (!items) return false;
  if (items.length === 0) return true;
  const pathDigest = fieldFlowPathDigestV1(properties.sinkFieldPath as string[]);
  let previous = '';
  for (const item of items) {
    if (typeof item !== 'string' || item <= previous || item.length > 256) return false;
    const [version, modelId, sink, digest, extra] = item.split('/');
    const model = FIELD_FLOW_SANITIZER_MODELS_V1.find((entry) => entry.modelId === modelId);
    if (version !== 'v1' || extra !== undefined || digest !== pathDigest || !model
      || !model.clears.some((allowed) => allowed === sink)
      || properties.knowledge === 'KNOWN' && sink === properties.sinkClass) return false;
    previous = item;
  }
  return true;
}
function origin(properties: RecordValue): boolean {
  return integer(properties.sourceNodeOrdinal) && typeof properties.sourceNodeDigest === 'string'
    && DIGEST.test(properties.sourceNodeDigest) && fieldPath(properties.sourceFieldPath) && labels(properties);
}
function summary(properties: RecordValue): boolean {
  if (!origin(properties) || !member(properties.flowKind, ENUMS.fieldFlowKind) || !member(properties.reachability, ENUMS.fieldFlowReachability)
    || !member(properties.sinkClass, ENUMS.sinkClass) || !member(properties.sinkChannel, ENUMS.fieldFlowChannel)
    || !member(properties.edgeChannel, ENUMS.fieldFlowChannel) || !pointer(properties.sinkParameterPath)
    || 'propertyPath' in properties && !pointer(properties.propertyPath) || !fieldPath(properties.sinkFieldPath)
    || typeof properties.sourceProvenanceFactId !== 'string' || !DIGEST.test(properties.sourceProvenanceFactId)
    || !member(properties.knowledge, ENUMS.fieldFlowKnowledge)
    || !ordered(properties.unknownReasons, ENUMS.fieldFlowUnknownReason)) return false;
  const reasons = properties.unknownReasons;
  if (properties.knowledge === 'KNOWN' && (reasons.length !== 0 || properties.omittedAtoms !== 0 || properties.omittedSanitizers !== 0)
    || properties.knowledge === 'UNKNOWN' && reasons.length === 0
    || ((properties.omittedAtoms as number) > 0 || (properties.omittedSanitizers as number) > 0) && !reasons.includes('PAYLOAD_LIMIT')) return false;
  return tokens(properties);
}
function coverage(properties: RecordValue): boolean {
  if (!member(properties.capabilityId, ENUMS.fieldFlowCapability)
    || !member(properties.coverageStatus, ENUMS.fieldFlowCoverageStatus)
    || !ordered(properties.unknownReasons, ENUMS.fieldFlowUnknownReason)
    || !ordered(properties.taintChannels, ENUMS.fieldFlowActiveTaintChannel)
    || !ordered(properties.sinkChannels, ENUMS.fieldFlowChannel) || !ordered(properties.edgeChannels, ENUMS.fieldFlowChannel)) return false;
  const fields = properties.fieldsExamined as number;
  const known = properties.knownFields as number;
  const unknown = properties.unknownFields as number;
  if (known > fields || fields - known !== unknown || (properties.knownEmptyFields as number) > known
    || (properties.positiveFields as number) > fields || (properties.unknownReasons.length === 0) !== (unknown === 0)) return false;
  const omissions = ['unknownFields', 'omittedAtoms', 'omittedSanitizers', 'unmappedSources', 'unmappedSinks',
    'unmappedPaths', 'redactedPaths', 'invalidTokens', 'witnessUnavailable', 'omittedTraceSteps'];
  if (properties.coverageStatus === 'COMPLETE' && omissions.some((key) => properties[key] !== 0)) return false;
  return properties.coverageStatus !== 'FAILED' || Object.entries(properties).every(([key, value]) =>
    FIELD_FLOW_PROPERTY_TYPES_V1['dataflow.coverage.v1'][key as keyof typeof FIELD_FLOW_PROPERTY_TYPES_V1['dataflow.coverage.v1']] !== INTEGER_PROPERTY_TYPE || value === 0);
}
/** No raw property values or rejected path text are returned in diagnostics. */
export function readFieldFlowPropertiesV1(kind: unknown, input: unknown): FieldFlowPropertiesV1 | undefined {
  try {
    if (!isFieldFlowFactKindV1(kind)) return;
    const properties = record(input);
    if (!properties) return;
    const schema: Readonly<Record<string, FieldFlowPropertyTypeV1>> = FIELD_FLOW_PROPERTY_TYPES_V1[kind];
    if (Object.keys(properties).some((key) => !Object.hasOwn(schema, key))
      || FIELD_FLOW_REQUIRED_PROPERTIES_V1[kind].some((key) => !Object.hasOwn(properties, key))) return;
    for (const [key, type] of Object.entries(schema)) {
      if (key === 'propertyPath' && !Object.hasOwn(properties, key)) continue;
      if (type === INTEGER_PROPERTY_TYPE) { if (!integer(properties[key])) return; }
      else if (type === 'STRING') { if (typeof properties[key] !== 'string') return; }
      else if (type === 'STRING_LIST') {
        const items = list(properties[key], 32);
        if (!items || !items.every((item) => typeof item === 'string')) return;
        properties[key] = Object.freeze(items);
      } else return;
    }
    const valid = kind === 'dataflow.provenance.v1' ? origin(properties)
      : kind === 'dataflow.summary.v3' ? summary(properties)
      : kind === 'dataflow.coverage.v1' ? coverage(properties) : false;
    return valid ? Object.freeze(Object.fromEntries(Object.entries(properties))) as FieldFlowPropertiesV1 : undefined;
  } catch { return; }
}
export function validateFieldFlowProperties(kind: unknown, input: unknown): boolean {
  return readFieldFlowPropertiesV1(kind, input) !== undefined;
}
export function validateFieldFlowSubject(kind: unknown, input: unknown, propertiesInput: unknown): boolean {
  try {
    if (!isFieldFlowFactKindV1(kind)) return false;
    const subject = record(input);
    if (!subject) return false;
    if (kind === 'dataflow.coverage.v1') return subject.kind === 'WORKFLOW' && Object.keys(subject).length === 1;
    if (subject.kind !== 'NODE' || Object.keys(subject).length !== 2) return false;
    const node = record(subject.node);
    if (!node || !integer(node.ordinal) || typeof node.identityDigest !== 'string' || !DIGEST.test(node.identityDigest)) return false;
    if (kind === 'dataflow.summary.v3') return true;
    const properties = record(propertiesInput);
    return properties !== undefined && properties.sourceNodeOrdinal === node.ordinal && properties.sourceNodeDigest === node.identityDigest;
  } catch { return false; }
}
