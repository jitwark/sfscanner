import type { ScannerLimitsV2 } from '@hub/contracts';
import {
  MISSING_OR_INVALID_CREDENTIAL_MAPPING,
  MISSING_OR_INVALID_ENDPOINT,
  readJsonPointerValue,
  validateCredentialMapping,
  validateEndpointSelection,
} from '@hub/scanner-core/remediation/fix-preconditions';
import {
  createFixSuggestion,
  planFixSuggestion,
  type FixPlanV1,
  type FixPrerequisiteCodeV1,
  type FixPrerequisiteEvidenceV1,
  type FixSuggestionFactV1,
} from '@hub/scanner-core/remediation/fix-suggestion';
import { parseSourceDocument } from '@hub/scanner-core/source/source-parser';
import { readInputBytes, type InputReadHost } from './input-read';
import { normalizeAdmittedPathV2, isAbsoluteAdmittedPathV2 } from './path-admission';

export const CREDENTIAL_MAPPING_RECEIPT_SCHEMA = 'selected-credential-mapping-v1' as const;
export const ENDPOINT_RECEIPT_SCHEMA = 'selected-endpoint-receipt-v1' as const;
const RECEIPT_MAX_BYTES = 65_536;
const RECEIPT_CODES: Readonly<Record<string, true>> = Object.freeze({
  CREDENTIAL_MAPPING: true,
  ENDPOINT_COMPATIBILITY: true,
});

export type FixPlanRequestV1 = Readonly<{
  root?: string; input: string; suggestion: unknown; mapping?: string; endpointReceipt?: string;
  evidence?: readonly FixPrerequisiteEvidenceV1[]; limits?: Partial<ScannerLimitsV2>;
}>;
export type FixPlanHostV1 = Readonly<{ inputRead?: InputReadHost; plan?: typeof planFixSuggestion }>;
export type FixPlanFailureCodeV1 = 'USAGE' | 'INPUT_READ_FAILED' | 'WORKFLOW_TOO_LARGE' | 'INVALID_JSON'
  | typeof MISSING_OR_INVALID_CREDENTIAL_MAPPING | typeof MISSING_OR_INVALID_ENDPOINT;
export type FixPlanRunResultV1 =
  | Readonly<{ ok: true; plan: FixPlanV1; suggestion?: FixSuggestionFactV1; prerequisites: readonly FixPrerequisiteEvidenceV1[] }>
  | Readonly<{ ok: false; code: FixPlanFailureCodeV1; message: string }>;
type ReceiptOutcomeV1 = Readonly<{ ok: true; evidence?: FixPrerequisiteEvidenceV1 }>
  | Readonly<{ ok: false; reason: FixPlanFailureCodeV1; message: string }>;
type ObservationV1 = Readonly<{ kind: 'PRESENT'; value: unknown }>
  | Readonly<{ kind: 'MISSING' }> | Readonly<{ kind: 'UNREADABLE' }>;
const NO_EVIDENCE: ReceiptOutcomeV1 = Object.freeze({ ok: true });
const UNREADABLE: ObservationV1 = Object.freeze({ kind: 'UNREADABLE' });
const MISSING: ObservationV1 = Object.freeze({ kind: 'MISSING' });

/**
 * Planner composition: reads the caller's workflow and explicit receipt files, proves the
 * prerequisites the selected suggestion requires, then dispatches the frozen planner. It never
 * writes, never applies a patch and never invents a credential, endpoint or installation.
 */
export async function runFixPlanV2(
  request: FixPlanRequestV1,
  host: FixPlanHostV1 = {},
): Promise<FixPlanRunResultV1> {
  const root = normalizeAdmittedPathV2(request.root ?? process.cwd());
  if (root === undefined || !isAbsoluteAdmittedPathV2(root)) return failure('USAGE', 'Root must be an absolute local directory.');
  if (typeof request.input !== 'string' || request.input === '-') {
    return failure('USAGE', 'Planning requires a file input; standard input cannot be re-read.');
  }
  if (!isReceiptPath(request.mapping) || !isReceiptPath(request.endpointReceipt)) {
    return failure('USAGE', 'Receipt options must be admitted relative file paths.');
  }
  const read = await readInputBytes(request.input, { baseDirectory: root, host: host.inputRead });
  if (!read.ok) return failure(read.code === 'INVALID_CONFIG' ? 'USAGE' : read.code, read.message);

  const plan = host.plan ?? planFixSuggestion;
  const created = createFixSuggestion(request.suggestion);
  if (!created.ok) {
    return Object.freeze({
      ok: true,
      plan: plan({ suggestion: request.suggestion as FixSuggestionFactV1, bytes: read.bytes }),
      prerequisites: Object.freeze([]),
    });
  }
  const explicit = resolveExplicitEvidence(request.evidence);
  if (!explicit.ok) return failure('USAGE', explicit.message);
  const evidence: FixPrerequisiteEvidenceV1[] = [...explicit.entries];
  const required: ReadonlySet<string> = new Set(created.suggestion.prerequisites);

  const credential = await credentialEvidence(created.suggestion, required, request.mapping, root, host);
  if (!credential.ok) return failure(credential.reason, credential.message);
  if (credential.evidence) evidence.push(credential.evidence);

  const endpoint = await endpointEvidence(
    created.suggestion, required, request.endpointReceipt, root, host, read.bytes, request.limits,
  );
  if (!endpoint.ok) return failure(endpoint.reason, endpoint.message);
  if (endpoint.evidence) evidence.push(endpoint.evidence);

  const prerequisites = Object.freeze([...evidence]);
  return Object.freeze({
    ok: true,
    plan: plan({ suggestion: created.suggestion, bytes: read.bytes, prerequisites, limits: request.limits }),
    suggestion: created.suggestion,
    prerequisites,
  });
}

async function credentialEvidence(
  suggestion: FixSuggestionFactV1,
  required: ReadonlySet<string>,
  mappingPath: string | undefined,
  root: string,
  host: FixPlanHostV1,
): Promise<ReceiptOutcomeV1> {
  if (!required.has('CREDENTIAL_MAPPING')) return NO_EVIDENCE;
  const refusal = (message: string): ReceiptOutcomeV1 => Object.freeze({
    ok: false, reason: MISSING_OR_INVALID_CREDENTIAL_MAPPING, message,
  });
  if (mappingPath === undefined) return refusal('This fix requires an explicit credential mapping receipt.');
  if (suggestion.resource.kind === 'WORKFLOW_ROOT') return refusal('A credential mapping requires a node-scoped suggestion.');
  const receipt = await readReceipt(
    mappingPath, root, host, CREDENTIAL_MAPPING_RECEIPT_SCHEMA, ['schemaVersion', 'mapping', 'inventory'],
  );
  if (receipt === undefined) return refusal('Credential mapping receipt is missing, unreadable or malformed.');
  const validated = validateCredentialMapping({
    mapping: receipt.mapping,
    inventory: receipt.inventory,
    nodeIdentityDigest: suggestion.resource.nodeIdentityDigest,
  });
  if (!validated.ok) return refusal('Credential mapping does not prove an existing ID and type for this node.');
  return Object.freeze({ ok: true, evidence: validated.evidence });
}

async function endpointEvidence(
  suggestion: FixSuggestionFactV1,
  required: ReadonlySet<string>,
  receiptPath: string | undefined,
  root: string,
  host: FixPlanHostV1,
  bytes: Uint8Array,
  limits: Partial<ScannerLimitsV2> | undefined,
): Promise<ReceiptOutcomeV1> {
  if (!required.has('ENDPOINT_COMPATIBILITY')) return NO_EVIDENCE;
  const refusal = (message: string): ReceiptOutcomeV1 => Object.freeze({
    ok: false, reason: MISSING_OR_INVALID_ENDPOINT, message,
  });
  if (receiptPath === undefined) return refusal('This fix requires an explicit endpoint receipt.');
  if (suggestion.resource.kind === 'WORKFLOW_ROOT') return refusal('Endpoint evidence requires a node-scoped suggestion.');
  const receipt = await readReceipt(receiptPath, root, host, ENDPOINT_RECEIPT_SCHEMA, ['schemaVersion', 'selection']);
  if (receipt === undefined) return refusal('Endpoint receipt is missing, unreadable or malformed.');
  const observation = observeEndpoint(bytes, suggestion.resource.pointer, limits);
  if (observation.kind === 'UNREADABLE') return NO_EVIDENCE;
  if (observation.kind === 'MISSING') return refusal('The selected endpoint is not present in the input workflow.');
  const validated = validateEndpointSelection({
    selection: receipt.selection,
    nodeIdentityDigest: suggestion.resource.nodeIdentityDigest,
    currentEndpoint: observation.value,
  });
  if (!validated.ok) return refusal('Endpoint selection is stale, inferred or lacks compatibility evidence.');
  return Object.freeze({ ok: true, evidence: validated.evidence });
}

async function readReceipt(
  path: string,
  root: string,
  host: FixPlanHostV1,
  schemaVersion: string,
  keys: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const read = await readInputBytes(path, {
    baseDirectory: root, maxBytes: RECEIPT_MAX_BYTES, host: host.inputRead,
  });
  if (!read.ok) return undefined;
  const parsed = parseSourceDocument(read.bytes);
  if (!parsed.ok || parsed.document.duplicateCount > 0) return undefined;
  const text = decodeText(read.bytes);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    return undefined;
  }
  return record.schemaVersion === schemaVersion ? record : undefined;
}

function observeEndpoint(
  bytes: Uint8Array,
  pointer: string,
  limits: Partial<ScannerLimitsV2> | undefined,
): ObservationV1 {
  const parsed = parseSourceDocument(bytes, limits);
  if (!parsed.ok || parsed.document.duplicateCount > 0) return UNREADABLE;
  const text = decodeText(bytes);
  if (text === undefined) return UNREADABLE;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  const value = readJsonPointerValue(root, pointer);
  return value.ok ? Object.freeze({ kind: 'PRESENT' as const, value: value.value }) : MISSING;
}

function resolveExplicitEvidence(
  value: readonly FixPrerequisiteEvidenceV1[] | undefined,
): Readonly<{ ok: true; entries: readonly FixPrerequisiteEvidenceV1[] }> | Readonly<{ ok: false; message: string }> {
  if (value === undefined) return Object.freeze({ ok: true, entries: Object.freeze([]) });
  if (!Array.isArray(value)) return Object.freeze({ ok: false, message: 'Prerequisite evidence must be an array.' });
  const entries: FixPrerequisiteEvidenceV1[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return Object.freeze({ ok: false, message: 'Prerequisite evidence records need a code and digest.' });
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.code !== 'string'
      || !Object.prototype.hasOwnProperty.call(record, 'evidenceDigest')
      || typeof record.evidenceDigest !== 'string') {
      return Object.freeze({ ok: false, message: 'Prerequisite evidence records need a code and digest.' });
    }
    if (RECEIPT_CODES[record.code] === true) {
      return Object.freeze({ ok: false, message: 'Receipt-backed prerequisites must come from their receipt file.' });
    }
    entries.push(Object.freeze({ code: record.code as FixPrerequisiteCodeV1, evidenceDigest: record.evidenceDigest }));
  }
  return Object.freeze({ ok: true, entries: Object.freeze(entries) });
}

function isReceiptPath(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value !== '-');
}

function decodeText(bytes: Uint8Array): string | undefined {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
}

function failure(code: FixPlanFailureCodeV1, message: string): FixPlanRunResultV1 {
  return Object.freeze({ ok: false, code, message });
}
