import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ScannerLimitsV2 } from '@hub/contracts';
import { classifyProviderToken } from '../analyzers/secrets/provider-token-registry';
import { classifySecretValue } from '../secret-classifier';
import { parseSourceDocument } from '../source/source-parser';
import type { SourceValueV2 } from '../source/source-types';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { freeze } from '../workflow-v2/workflow-digest';
import { applyPatch, decodeJsonPointer, validatePatch, type JsonValue, type PatchOpV1 } from './json-patch';

export type Sha256V1 = string;
const PREREQUISITE_CODES = Object.freeze({ EXACT_VERSION: true, SOURCE_DIGEST_MATCH: true, CREDENTIAL_MAPPING: true, ENDPOINT_COMPATIBILITY: true, USER_CONFIRMATION: true });
export type FixPrerequisiteCodeV1 = keyof typeof PREREQUISITE_CODES;
const REGION_BY_RESOURCE = Object.freeze({ NODE_PARAMETER: 'parameters', CREDENTIAL_REFERENCE: 'credentials', ENDPOINT: 'parameters' } as const);
export type FixResourceKindV1 = 'WORKFLOW_ROOT' | keyof typeof REGION_BY_RESOURCE;
export type FixResourceV1 = Readonly<{ kind: 'WORKFLOW_ROOT' }> | Readonly<{ kind: keyof typeof REGION_BY_RESOURCE; nodeIdentityDigest: Sha256V1; pointer: string }>;
export type KnownPackageVersionV1 = Readonly<{ packageName: string; version: string; inventoryDigest: Sha256V1 }>;

export const FIX_RATIONALES = Object.freeze({
  REMOVE_INSECURE_OVERRIDE: Object.freeze({
    title: 'Remove the insecure endpoint override',
    rationale: 'Deletes a hard-coded override so the node falls back to its reviewed default endpoint.',
    caveat: 'The plan rewrites the workflow with two-space formatting; re-scan before relying on the result.',
  } satisfies Readonly<{ title: string; rationale: string; caveat: string }>),
});
export type FixRationaleIdV1 = keyof typeof FIX_RATIONALES;
export type FixTemplateV1 = Readonly<{
  resourceKinds: readonly FixResourceKindV1[];
  requires: readonly FixPrerequisiteCodeV1[];
  ops: (pointer: string) => readonly PatchOpV1[];
}>;
export const FIX_TEMPLATES = Object.freeze({
  REMOVE_INSECURE_OVERRIDE: Object.freeze({
    resourceKinds: Object.freeze(['NODE_PARAMETER', 'ENDPOINT'] as const),
    requires: Object.freeze(['USER_CONFIRMATION'] as const),
    ops: (pointer: string): readonly PatchOpV1[] => Object.freeze([Object.freeze({ op: 'remove' as const, path: pointer })]),
  } satisfies FixTemplateV1),
});
export type FixTemplateIdV1 = keyof typeof FIX_TEMPLATES;

export type FixSuggestionFactV1 = Readonly<{
  id: string; findingIds: readonly [string, ...string[]]; sourceSha256: Sha256V1; workflowDigest: Sha256V1;
  targetVersion: KnownPackageVersionV1; resource: FixResourceV1; templateId: FixTemplateIdV1;
  rationaleId: FixRationaleIdV1; prerequisites: readonly FixPrerequisiteCodeV1[];
}>;
export type FixPrerequisiteEvidenceV1 = Readonly<{ code: FixPrerequisiteCodeV1; evidenceDigest: Sha256V1 }>;
export type FixPlanRefusalV1 =
  | 'STALE_SOURCE' | 'DUPLICATE_KEYS' | 'INVALID_JSON' | 'SOURCE_LIMIT' | 'UNKNOWN_TARGET' | 'UNKNOWN_VERSION'
  | 'UNKNOWN_RESOURCE' | 'UNKNOWN_OPERATION' | 'UNSUPPORTED_OPERATION' | 'MALFORMED_PATCH' | 'CONFLICTING_PATCH'
  | 'MISSING_PREREQUISITE' | 'UNSAFE_PATCH_VALUE' | 'UNROUNDTRIPPABLE_NUMBER';
export type FixPlanV1 =
  | Readonly<{ status: 'READY'; suggestionId: string; sourceSha256: Sha256V1; resultSha256: Sha256V1; patch: readonly PatchOpV1[] }>
  | Readonly<{ status: 'REFUSED'; reason: FixPlanRefusalV1; cause?: string }>;
export type FixSuggestionCreationV1 =
  | Readonly<{ ok: true; suggestion: FixSuggestionFactV1 }>
  | Readonly<{ ok: false; reason: FixPlanRefusalV1 }>;
export type PlanFixRequestV1 = Readonly<{ suggestion: FixSuggestionFactV1; bytes: Uint8Array; prerequisites?: readonly FixPrerequisiteEvidenceV1[]; limits?: Partial<ScannerLimitsV2> }>;

const SUGGESTION_KEYS = ['id', 'findingIds', 'sourceSha256', 'workflowDigest', 'targetVersion', 'resource', 'templateId', 'rationaleId', 'prerequisites'] as const;
const MALFORMED: Readonly<{ ok: false; reason: FixPlanRefusalV1 }> = Object.freeze({ ok: false, reason: 'MALFORMED_PATCH' });

export function createFixSuggestion(input: unknown): FixSuggestionCreationV1 {
  const record = asRecord(input);
  if (!record || !exactKeys(record, SUGGESTION_KEYS)) return MALFORMED;
  const { id, findingIds, sourceSha256, workflowDigest, targetVersion, resource, templateId, rationaleId, prerequisites } = record;
  if (!nonEmptyString(id) || !isSha256(sourceSha256) || !isSha256(workflowDigest)) return MALFORMED;
  if (!Array.isArray(findingIds) || findingIds.length === 0 || !findingIds.every(nonEmptyString)) return MALFORMED;
  const [firstFinding, ...restFindings] = findingIds as [string, ...string[]];
  const version = asRecord(targetVersion);
  if (!version || !exactKeys(version, ['packageName', 'version', 'inventoryDigest'])) return MALFORMED;
  if (!nonEmptyString(version.packageName) || !nonEmptyString(version.version) || !isSha256(version.inventoryDigest)) return MALFORMED;
  const resolved = resolveResource(resource);
  if (!resolved) return MALFORMED;
  if (!hasKey(FIX_TEMPLATES, templateId) || !hasKey(FIX_RATIONALES, rationaleId)) return { ok: false, reason: 'UNKNOWN_OPERATION' };
  const codes = resolvePrerequisites(prerequisites);
  if (!codes) return { ok: false, reason: 'MISSING_PREREQUISITE' };
  const required: FixPrerequisiteCodeV1[] = [...FIX_TEMPLATES[templateId].requires];
  if (resolved.kind === 'CREDENTIAL_REFERENCE') required.push('CREDENTIAL_MAPPING');
  if (resolved.kind === 'ENDPOINT') required.push('ENDPOINT_COMPATIBILITY');
  if (required.some((code) => !codes.includes(code))) return { ok: false, reason: 'MISSING_PREREQUISITE' };
  return {
    ok: true,
    suggestion: freeze({
      id, findingIds: [firstFinding, ...restFindings] as const, sourceSha256, workflowDigest,
      targetVersion: { packageName: version.packageName, version: version.version, inventoryDigest: version.inventoryDigest },
      resource: resolved, templateId, rationaleId, prerequisites: Object.freeze(codes),
    } satisfies FixSuggestionFactV1),
  };
}

export function planFixSuggestion(request: PlanFixRequestV1): FixPlanV1 {
  const created = createFixSuggestion(request.suggestion);
  if (!created.ok) return refuse(created.reason);
  const suggestion = created.suggestion;
  const parsed = parseSourceDocument(request.bytes, request.limits);
  if (!parsed.ok) {
    if (parsed.code === 'WORKFLOW_TOO_COMPLEX') {
      return refuse(parsed.cause === 'DUPLICATE_KEY_LIMIT' ? 'DUPLICATE_KEYS' : 'SOURCE_LIMIT', parsed.cause);
    }
    return refuse(parsed.code === 'WORKFLOW_TOO_LARGE' ? 'SOURCE_LIMIT' : 'INVALID_JSON');
  }
  const document = parsed.document;
  if (document.duplicateCount > 0) return refuse('DUPLICATE_KEYS');
  if (document.rawSha256 !== suggestion.sourceSha256) return refuse('STALE_SOURCE');
  const numberPath = firstUnroundtrippableNumber(document.root);
  if (numberPath !== undefined) return refuse('UNROUNDTRIPPABLE_NUMBER', numberPath);
  const normalized = normalizeSecurityWorkflow(document, request.limits);
  if (!normalized.ok) return normalized.code === 'WORKFLOW_TOO_COMPLEX' ? refuse('SOURCE_LIMIT', normalized.cause) : refuse('UNKNOWN_TARGET');
  if (normalized.semanticSha256 !== suggestion.workflowDigest) return refuse('UNKNOWN_TARGET');
  let pointer = '';
  if (suggestion.resource.kind !== 'WORKFLOW_ROOT') {
    const resource = suggestion.resource;
    const matches = normalized.workflow.nodes.filter((node) => node.ref.identityDigest === resource.nodeIdentityDigest);
    const node = matches.length === 1 ? matches[0] : undefined;
    if (!node) return refuse('UNKNOWN_TARGET');
    if (node.type !== suggestion.targetVersion.packageName || node.typeVersion !== suggestion.targetVersion.version) return refuse('UNKNOWN_VERSION');
    if (!resource.pointer.startsWith(`${node.ref.source.pointer}/${REGION_BY_RESOURCE[resource.kind]}/`)) return refuse('UNKNOWN_RESOURCE');
    if (!memberPointers(document.root).has(resource.pointer)) return refuse('UNKNOWN_RESOURCE');
    pointer = resource.pointer;
  }
  const template = FIX_TEMPLATES[suggestion.templateId];
  if (!template.resourceKinds.some((kind) => kind === suggestion.resource.kind)) return refuse('UNKNOWN_OPERATION');
  const validated = validatePatch(template.ops(pointer));
  if (!validated.ok) return refuse(validated.code, validated.path);
  const unsafe = validated.ops.find((op) => 'value' in op && isUnsafePatchValue(op.value));
  if (unsafe) return refuse('UNSAFE_PATCH_VALUE', unsafe.path);
  const evidence = request.prerequisites ?? [];
  const missing = suggestion.prerequisites.find((code) => !evidence.some((entry) => entry.code === code && isSha256(entry.evidenceDigest)));
  if (missing !== undefined) return refuse('MISSING_PREREQUISITE', missing);
  const text = decodeUtf8(request.bytes);
  if (text === undefined) return refuse('INVALID_JSON');
  const applied = applyPatch(JSON.parse(text) as JsonValue, validated.ops);
  if (!applied.ok) return refuse(applied.code, applied.path);
  return freeze({
    status: 'READY', suggestionId: suggestion.id, sourceSha256: document.rawSha256,
    resultSha256: bytesToHex(sha256(serializeWorkflowV1(applied.value))), patch: validated.ops,
  } satisfies FixPlanV1);
}

export function serializeWorkflowV1(value: JsonValue): Uint8Array { return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`); }

const UNSAFE_LITERAL = /\$env\.|CREDENTIAL_REPLACE_ME/;

export function isUnsafePatchValue(value: JsonValue): boolean {
  if (typeof value === 'string') return UNSAFE_LITERAL.test(value) || classifyProviderToken(value) !== undefined || classifySecretValue(value) !== undefined;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => isUnsafePatchValue(item));
  const record = value as Readonly<Record<string, JsonValue>>;
  return Object.keys(record).some((key) => isUnsafePatchValue(record[key]));
}

function refuse(reason: FixPlanRefusalV1, cause?: string): FixPlanV1 {
  return freeze({ status: 'REFUSED', reason, ...(cause === undefined ? {} : { cause }) } satisfies FixPlanV1);
}

function resolveResource(value: unknown): FixResourceV1 | undefined {
  const record = asRecord(value);
  if (!record || typeof record.kind !== 'string') return undefined;
  if (record.kind === 'WORKFLOW_ROOT') return exactKeys(record, ['kind']) ? Object.freeze({ kind: 'WORKFLOW_ROOT' } as const) : undefined;
  if (!hasKey(REGION_BY_RESOURCE, record.kind) || !exactKeys(record, ['kind', 'nodeIdentityDigest', 'pointer'])) return undefined;
  if (!isSha256(record.nodeIdentityDigest) || !nonEmptyString(record.pointer) || !decodeJsonPointer(record.pointer)) return undefined;
  return Object.freeze({ kind: record.kind, nodeIdentityDigest: record.nodeIdentityDigest, pointer: record.pointer });
}

function resolvePrerequisites(value: unknown): FixPrerequisiteCodeV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const codes: FixPrerequisiteCodeV1[] = [];
  for (const code of value) {
    if (!hasKey(PREREQUISITE_CODES, code) || codes.includes(code)) return undefined;
    codes.push(code);
  }
  return codes;
}

function firstUnroundtrippableNumber(value: SourceValueV2): string | undefined {
  if (value.kind === 'NUMBER') return numberRoundTrips(value.lexeme, value.value) ? undefined : value.ref.pointer;
  if (value.kind === 'OBJECT') {
    for (const member of value.members) {
      const path = firstUnroundtrippableNumber(member.value);
      if (path !== undefined) return path;
    }
  } else if (value.kind === 'ARRAY') {
    for (const item of value.items) {
      const path = firstUnroundtrippableNumber(item);
      if (path !== undefined) return path;
    }
  }
  return undefined;
}

function numberRoundTrips(lexeme: string, value: number): boolean {
  if (!Number.isFinite(value) || Object.is(value, -0)) return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(lexeme)) {
    try {
      return BigInt(lexeme) === BigInt(value);
    } catch {
      return false;
    }
  }
  return Number(lexeme) === value;
}

function memberPointers(root: SourceValueV2): Set<string> {
  const pointers = new Set<string>();
  const pending: SourceValueV2[] = [root];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (value.kind === 'OBJECT') {
      for (const member of value.members) {
        pointers.add(member.ref.pointer);
        pending.push(member.value);
      }
    } else if (value.kind === 'ARRAY') {
      for (const item of value.items) pending.push(item);
    }
  }
  return pointers;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasKey<T extends object>(registry: T, key: unknown): key is Extract<keyof T, string> {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(registry, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isSha256(value: unknown): value is Sha256V1 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
