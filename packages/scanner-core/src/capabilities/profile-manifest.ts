import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '../canonical-json';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import type { AnalyzerContextV2, CapabilityCandidateV2 } from './scheduler';

export type ProfileCapabilityV2 = Readonly<{ id: string; version: string; required: boolean; dependsOn: readonly string[]; ruleIds: readonly string[] }>;
export type ProfileManifestV2 = Readonly<{ schemaVersion: 'scanner-profile-v2'; id: string; version: string; capabilities: readonly ProfileCapabilityV2[]; scoringPolicyVersion: string; digest: string }>;
export type ProfileRegistryEntryV2 = Readonly<ProfileCapabilityV2 & { run(context: AnalyzerContextV2): CapabilityCandidateV2 }>;
export type ProfileManifestInvalidReason = 'UNKNOWN_CAPABILITY' | 'DUPLICATE_CAPABILITY' | 'DUPLICATE_RULE_OWNER' | 'MISSING_RULE_OWNER' | 'UNKNOWN_RULE' | 'MISSING_DEPENDENCY' | 'FORWARD_DEPENDENCY' | 'DEPENDENCY_CYCLE' | 'MANIFEST_DIGEST_MISMATCH' | 'PROFILE_NOT_ADMITTED';
export type ProfileManifestValidationResult = Readonly<
  | { ok: true; manifest: ProfileManifestV2 }
  | { ok: false; code: 'PROFILE_MANIFEST_INVALID' | 'PROFILE_MANIFEST_NOT_ADMITTED'; reason: ProfileManifestInvalidReason }
>;

const CAPABILITY_KEYS = ['id', 'version', 'required', 'dependsOn', 'ruleIds'] as const;
const MANIFEST_KEYS = ['schemaVersion', 'id', 'version', 'capabilities', 'scoringPolicyVersion', 'digest'] as const;
const RUN_KEYS = [...CAPABILITY_KEYS, 'run'] as const;
/**
 * Rule ownership is a property of the rule, not a second declaration: the safe-fact evidence
 * registry (`SAFE_FACT_EVIDENCE_MAPPINGS_V2`) is the single owner authority behind the admitted
 * rule's `capabilityId`, so a capability's `ruleIds` is projected from it in registry order.
 * Nothing here may hand-declare an owner, claim a rule the registry does not know, or leave a
 * registry rule unowned.
 */
const KNOWN_RULE_IDS: ReadonlySet<string> = new Set(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map(({ ruleId }) => ruleId));
const NO_RULES: readonly string[] = Object.freeze([]);
const RULE_IDS_BY_CAPABILITY: ReadonlyMap<string, readonly string[]> = (() => {
  const owned = new Map<string, string[]>();
  for (const { ruleId, ownerCapabilityId } of SAFE_FACT_EVIDENCE_MAPPINGS_V2) {
    const rules = owned.get(ownerCapabilityId);
    if (rules) rules.push(ruleId); else owned.set(ownerCapabilityId, [ruleId]);
  }
  return new Map([...owned].map(([capabilityId, rules]) => [capabilityId, Object.freeze(rules)] as const));
})();

const SCORING_POLICY_VERSION = 'secureflow-risk-v2@2.0.0';
const MAX_CAPABILITIES = 32;
const MAX_LIST_ITEMS = 17;
const MAX_STRING_LENGTH = 128;

function capability(id: string, required: boolean, dependsOn: readonly string[]): ProfileCapabilityV2 {
  return Object.freeze({ id, version: '2.0.0', required, dependsOn: Object.freeze([...dependsOn]), ruleIds: RULE_IDS_BY_CAPABILITY.get(id) ?? NO_RULES });
}
function buildManifest(id: string, capabilities: readonly ProfileCapabilityV2[]): ProfileManifestV2 {
  const body = { schemaVersion: 'scanner-profile-v2' as const, id, version: '2.0.0', capabilities: Object.freeze([...capabilities]), scoringPolicyVersion: SCORING_POLICY_VERSION };
  return Object.freeze({ ...body, digest: computeProfileManifestDigest(body) });
}

const source = capability('source-normalization', true, []);
const insights = capability('workflow-insights', true, ['source-normalization']);
const structural = capability('structural-policies', true, ['source-normalization']);
const assessment = capability('assessment', true, ['workflow-insights', 'structural-policies']);
const presentation = capability('presentation-facts', true, ['assessment']);

export const BETA_DEFAULT_PROFILE_MANIFEST = buildManifest('beta-default', [source, insights, structural, assessment, presentation]);
export const BETA_HARDENED_PROFILE_MANIFEST = buildManifest('beta-hardened', [
  source, insights, structural, capability('expression-security', false, ['source-normalization']),
  capability('javascript-security', false, ['source-normalization']),
  capability('python-security', false, ['source-normalization']),
  capability('graph-semantics', false, ['source-normalization']),
  capability('taint-confidentiality', false, ['graph-semantics', 'expression-security', 'javascript-security', 'python-security']),
  capability('taint-integrity', false, ['graph-semantics', 'expression-security', 'javascript-security', 'python-security']),
  capability('agentic-control', false, ['graph-semantics', 'taint-confidentiality', 'taint-integrity']), assessment, presentation,
]);
export const PROFILE_MANIFEST_REGISTRY_V2 = Object.freeze([BETA_DEFAULT_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST]);
export const ADMITTED_PROFILE_MANIFESTS_V2 = Object.freeze([BETA_DEFAULT_PROFILE_MANIFEST]);
export const PROFILE_MANIFEST_REGISTRY = PROFILE_MANIFEST_REGISTRY_V2;
export const ADMITTED_PROFILE_REGISTRY_V2 = ADMITTED_PROFILE_MANIFESTS_V2;
export const BETA_DEFAULT_MANIFEST = BETA_DEFAULT_PROFILE_MANIFEST;
export const BETA_HARDENED_MANIFEST = BETA_HARDENED_PROFILE_MANIFEST;

export function computeProfileManifestDigest(manifest: Omit<ProfileManifestV2, 'digest'>): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(manifest))));
}

export function isProfileAdmitted(candidate: unknown): boolean {
  try {
    const manifest = readManifest(candidate, true);
    const { digest, ...body } = manifest;
    return sameManifest(manifest, BETA_DEFAULT_PROFILE_MANIFEST) && computeProfileManifestDigest(body) === digest;
  } catch { return false; }
}

export function validateProfileManifest(candidate: unknown, registry: ReadonlyMap<string, ProfileRegistryEntryV2>): ProfileManifestValidationResult {
  try {
    const manifest = readManifest(candidate, false);
    const expected = PROFILE_MANIFEST_REGISTRY_V2.find((item) => item.id === manifest.id && item.version === manifest.version);
    if (!expected) return invalid('UNKNOWN_CAPABILITY');
    const ids = new Set<string>();
    for (const item of manifest.capabilities) { if (ids.has(item.id)) return invalid('DUPLICATE_CAPABILITY'); ids.add(item.id); }
    const index = new Map(manifest.capabilities.map((item, position) => [item.id, position]));
    for (const item of manifest.capabilities) for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) return invalid('MISSING_DEPENDENCY');
    }
    if (hasCycle(manifest.capabilities)) return invalid('DEPENDENCY_CYCLE');
    for (const item of manifest.capabilities) if (item.dependsOn.some((dependency) => index.get(dependency)! >= index.get(item.id)!)) return invalid('FORWARD_DEPENDENCY');
    const owners = new Map<string, string>();
    for (const item of manifest.capabilities) for (const ruleId of item.ruleIds) {
      if (!KNOWN_RULE_IDS.has(ruleId)) return invalid('UNKNOWN_RULE');
      if (owners.has(ruleId)) return invalid('DUPLICATE_RULE_OWNER');
      owners.set(ruleId, item.id);
    }
    for (const item of manifest.capabilities) for (const ruleId of RULE_IDS_BY_CAPABILITY.get(item.id) ?? NO_RULES) {
      if (owners.get(ruleId) !== item.id) return invalid('MISSING_RULE_OWNER');
    }
    if (!sameCapabilities(manifest.capabilities, expected.capabilities)) return invalid('UNKNOWN_CAPABILITY');
    if (manifest.scoringPolicyVersion !== SCORING_POLICY_VERSION) return invalid('UNKNOWN_CAPABILITY');
    const { digest: _digest, ...body } = manifest;
    if (computeProfileManifestDigest(body) !== manifest.digest) return invalid('MANIFEST_DIGEST_MISMATCH');
    const normalized = freezeManifest(manifest);
    if (!isProfileAdmitted(normalized)) return Object.freeze({ ok: false, code: 'PROFILE_MANIFEST_NOT_ADMITTED', reason: 'PROFILE_NOT_ADMITTED' });
    for (const item of normalized.capabilities) {
      const spec = registryEntry(registry, item.id);
      if (!spec || !sameCapability(item, readCapability(spec, true, false))) return invalid('UNKNOWN_CAPABILITY');
    }
    return Object.freeze({ ok: true, manifest: normalized });
  } catch { return invalid('UNKNOWN_CAPABILITY'); }
}

function invalid(reason: ProfileManifestInvalidReason): ProfileManifestValidationResult { return Object.freeze({ ok: false, code: 'PROFILE_MANIFEST_INVALID', reason }); }
function registryEntry(registry: ReadonlyMap<string, ProfileRegistryEntryV2>, id: string): ProfileRegistryEntryV2 | undefined {
  if (!(registry instanceof Map) || Object.getPrototypeOf(registry) !== Map.prototype) throw new TypeError();
  ownNames(registry, 0, 0);
  return Map.prototype.get.call(registry, id) as ProfileRegistryEntryV2 | undefined;
}
function readManifest(input: unknown, requireFrozen: boolean): ProfileManifestV2 {
  const value = record(input, MANIFEST_KEYS, requireFrozen); const capabilities = dense(value.capabilities, MAX_CAPABILITIES, requireFrozen).map((item) => readCapability(item, false, requireFrozen));
  if (value.schemaVersion !== 'scanner-profile-v2' || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.scoringPolicyVersion !== 'string' || typeof value.digest !== 'string') throw new TypeError();
  return { schemaVersion: value.schemaVersion, id: value.id, version: value.version, capabilities, scoringPolicyVersion: value.scoringPolicyVersion, digest: value.digest };
}
function readCapability(input: unknown, withRunner: boolean, requireFrozen: boolean): ProfileCapabilityV2 {
  const value = record(input, withRunner ? RUN_KEYS : CAPABILITY_KEYS, requireFrozen); const id = boundedString(value.id); const version = boundedString(value.version);
  const dependsOn = stringList(value.dependsOn, requireFrozen); const ruleIds = stringList(value.ruleIds, requireFrozen);
  if (typeof value.required !== 'boolean' || withRunner && typeof value.run !== 'function') throw new TypeError();
  return { id, version, required: value.required, dependsOn, ruleIds };
}
function record(input: unknown, allowed: readonly string[], requireFrozen: boolean): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError();
  if (requireFrozen && !Object.isFrozen(input)) throw new TypeError();
  const names = ownNames(input, allowed.length, 0);
  const result = Object.create(null) as Record<string, unknown>;
  for (const name of names) { if (!allowed.includes(name)) throw new TypeError(); const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) throw new TypeError(); result[name] = descriptor.value; }
  for (const name of allowed) if (!Object.prototype.hasOwnProperty.call(result, name)) throw new TypeError();
  return result;
}
function dense(input: unknown, maximum: number, requireFrozen: boolean): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new TypeError();
  if (requireFrozen && !Object.isFrozen(input)) throw new TypeError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) throw new TypeError();
  const names = ownNames(input, lengthDescriptor.value + 1, 0); if (names.length !== lengthDescriptor.value + 1) throw new TypeError();
  const values: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError(); values.push(descriptor.value); }
  for (const name of names) if (name !== 'length' && (!/^\d+$/.test(name) || Number(name) >= lengthDescriptor.value)) throw new TypeError();
  return values;
}
function stringList(input: unknown, requireFrozen: boolean): readonly string[] {
  const values = dense(input, MAX_LIST_ITEMS, requireFrozen); return Object.freeze(values.map((value) => boundedString(value)));
}
function ownNames(input: object, maximum: number, maximumSymbols: number): readonly string[] {
  const names = Object.getOwnPropertyNames(input); if (names.length > maximum) throw new TypeError();
  if (Object.getOwnPropertySymbols(input).length > maximumSymbols) throw new TypeError(); return names;
}
function boundedString(value: unknown): string { if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) throw new TypeError(); return value; }
function hasCycle(capabilities: readonly ProfileCapabilityV2[]): boolean {
  const indegree = new Map(capabilities.map((item) => [item.id, item.dependsOn.length])); const dependents = new Map(capabilities.map((item) => [item.id, [] as string[]]));
  for (const item of capabilities) for (const dependency of item.dependsOn) dependents.get(dependency)!.push(item.id);
  const queue = capabilities.filter((item) => indegree.get(item.id) === 0).map(({ id }) => id); let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) { const id = queue[cursor]; visited += 1; for (const dependent of dependents.get(id)!) { const next = indegree.get(dependent)! - 1; indegree.set(dependent, next); if (next === 0) queue.push(dependent); } }
  return visited !== capabilities.length;
}
function sameCapability(left: ProfileCapabilityV2, right: ProfileCapabilityV2): boolean { return left.id === right.id && left.version === right.version && left.required === right.required && sameList(left.dependsOn, right.dependsOn) && sameList(left.ruleIds, right.ruleIds); }
function sameCapabilities(left: readonly ProfileCapabilityV2[], right: readonly ProfileCapabilityV2[]): boolean { return left.length === right.length && left.every((item, index) => sameCapability(item, right[index])); }
function sameManifest(left: ProfileManifestV2, right: ProfileManifestV2): boolean { return left.schemaVersion === right.schemaVersion && left.id === right.id && left.version === right.version && left.scoringPolicyVersion === right.scoringPolicyVersion && left.digest === right.digest && sameCapabilities(left.capabilities, right.capabilities); }
function sameList(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function freezeManifest(manifest: ProfileManifestV2): ProfileManifestV2 {
  const capabilities = Object.freeze(manifest.capabilities.map((item) => Object.freeze({ ...item, dependsOn: Object.freeze([...item.dependsOn]), ruleIds: Object.freeze([...item.ruleIds]) })));
  return Object.freeze({ ...manifest, capabilities });
}
