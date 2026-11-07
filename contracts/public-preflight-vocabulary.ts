/** Closed public vocabulary for the dormant v4 preflight relations. */
export const PUBLIC_PREFLIGHT_RELATION_NAMES = ['preflightCoverage', 'preflightEvidence'] as const;

export const PUBLIC_PREFLIGHT_OMISSION_CODES = [
  'BODY_MISSING', 'BODY_SOURCE_UNAVAILABLE', 'BODY_UNPARSEABLE', 'BODY_REJECTED',
  'BODY_BINDING_UNKNOWN', 'COLLECTOR_REJECTED', 'COLLECTOR_LIMIT', 'COMPUTED_ACCESS',
  'UNSAFE_PARAMETER_PATH', 'NODE_NAME_WITHHELD', 'IDENTIFIER_WITHHELD',
  'CREDENTIAL_POINTER_WITHHELD', 'SUBWORKFLOW_ID_WITHHELD', 'INVALID_EXPORT_EVIDENCE',
] as const;

export const PUBLIC_PREFLIGHT_CATEGORY_ORDER = [
  'credential', 'community-node', 'integration', 'subworkflow', 'environment',
] as const;

export const PUBLIC_PREFLIGHT_CATEGORY_LABELS = Object.freeze({
  credential: 'Credential references at node',
  'community-node': 'Community package reference',
  integration: 'Integration observation',
  subworkflow: 'Subworkflow reference',
  environment: 'Environment reference',
} as const);

export const PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER = ['NODE', 'FIELD', 'CONTAINER'] as const;
export const PUBLIC_PREFLIGHT_BODY_STATUSES = [
  'AVAILABLE', 'MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED',
] as const;
export const PUBLIC_PREFLIGHT_COVERAGE_STATES = ['COMPLETE', 'PARTIAL', 'UNKNOWN'] as const;
export const PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS = [
  'url', 'options', 'headers', 'list', 'jsCode', 'text', 'value', 'jsonBody',
] as const;

/** Exact union and order of the bounded collector's admitted node-type literals. */
export const PUBLIC_PREFLIGHT_NODE_TYPES = [
  'n8n-nodes-base.set', 'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.switch',
  'n8n-nodes-base.filter', 'n8n-nodes-base.merge', 'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.splitOut', 'n8n-nodes-base.aggregate', 'n8n-nodes-base.itemLists',
  'n8n-nodes-base.sort', 'n8n-nodes-base.limit', 'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.wait', 'n8n-nodes-base.noOp', 'n8n-nodes-base.start',
  'n8n-nodes-base.stickyNote', 'n8n-nodes-base.dateTime', 'n8n-nodes-base.compareDatasets',
  'n8n-nodes-base.stopAndError', 'n8n-nodes-base.respondToWebhook', 'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.crypto',
  'n8n-nodes-base.httpRequest', 'n8n-nodes-base.graphql', 'n8n-nodes-base.slack',
  'n8n-nodes-base.gmail', 'n8n-nodes-base.postgres', 'n8n-nodes-base.executeWorkflow',
] as const;

export type PublicPreflightRelationName = (typeof PUBLIC_PREFLIGHT_RELATION_NAMES)[number];
export type PublicPreflightOmissionCode = (typeof PUBLIC_PREFLIGHT_OMISSION_CODES)[number];
export type PublicPreflightCategory = (typeof PUBLIC_PREFLIGHT_CATEGORY_ORDER)[number];
export type PublicPreflightPointerScope = (typeof PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER)[number];
export type PublicPreflightBodyStatus = (typeof PUBLIC_PREFLIGHT_BODY_STATUSES)[number];
export type PublicPreflightCoverageState = (typeof PUBLIC_PREFLIGHT_COVERAGE_STATES)[number];
export type PublicPreflightPublicLabel = (typeof PUBLIC_PREFLIGHT_CATEGORY_LABELS)[PublicPreflightCategory];
export type PublicPreflightNodeType = (typeof PUBLIC_PREFLIGHT_NODE_TYPES)[number];
export type PublicPreflightObservation = 'observed' | 'inferred' | 'unresolved';
export type PublicPreflightRequirement = 'unknown';
export type PublicPreflightOmissionCount = Readonly<{
  code: PublicPreflightOmissionCode;
  count: number;
  basis: 'EXACT' | 'LOWER_BOUND';
}>;

type OwnDataRecord = Readonly<Record<string, unknown>>;

function ownDataRecord(value: unknown, keys: readonly string[]): OwnDataRecord | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || names.some((name) => typeof name !== 'string' || !keys.includes(name))) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return;
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return;
  }
}

function readArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) return;
      entries.push(descriptor.value);
    }
    return Object.freeze(entries);
  } catch {
    return;
  }
}

export function readPublicPreflightOmissionCodes(value: unknown): readonly PublicPreflightOmissionCode[] | undefined {
  const values = readArray(value);
  if (!values) return;
  const indexes: number[] = [];
  for (const value of values) {
    const index = PUBLIC_PREFLIGHT_OMISSION_CODES.indexOf(value as PublicPreflightOmissionCode);
    if (index < 0 || (indexes.length > 0 && index <= indexes[indexes.length - 1]!)) return;
    indexes.push(index);
  }
  return Object.freeze(indexes.map((index) => PUBLIC_PREFLIGHT_OMISSION_CODES[index]!));
}

export function readPublicPreflightOmissionCounts(value: unknown): readonly PublicPreflightOmissionCount[] | undefined {
  const values = readArray(value);
  if (!values) return;
  const counts: PublicPreflightOmissionCount[] = [];
  let previous = -1;
  for (const value of values) {
    const record = ownDataRecord(value, ['code', 'count', 'basis']);
    if (!record) return;
    const code = record.code as PublicPreflightOmissionCode;
    const index = PUBLIC_PREFLIGHT_OMISSION_CODES.indexOf(code);
    const count = record.count;
    const basis = record.basis;
    if (index <= previous || !Number.isSafeInteger(count) || (count as number) <= 0
      || (basis !== 'EXACT' && basis !== 'LOWER_BOUND')) return;
    previous = index;
    counts.push(Object.freeze({ code, count: count as number, basis }));
  }
  return Object.freeze(counts);
}

Object.freeze(PUBLIC_PREFLIGHT_RELATION_NAMES);
Object.freeze(PUBLIC_PREFLIGHT_OMISSION_CODES);
Object.freeze(PUBLIC_PREFLIGHT_CATEGORY_ORDER);
Object.freeze(PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER);
Object.freeze(PUBLIC_PREFLIGHT_BODY_STATUSES);
Object.freeze(PUBLIC_PREFLIGHT_COVERAGE_STATES);
Object.freeze(PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS);
Object.freeze(PUBLIC_PREFLIGHT_NODE_TYPES);
