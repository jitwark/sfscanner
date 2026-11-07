import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { CliMetadataDocumentV2 } from './commands.js';
import {
  explainDocumentV2,
  profilesDocumentV2,
  rulesDocumentV2,
  validateConfigDocumentV2,
  versionDocumentV2,
} from './commands.js';

const KEYS: Record<string, readonly string[]> = {
  'n8n-scan-rules-v2': ['schemaVersion', 'tool', 'artifacts', 'rules'],
  'n8n-scan-explain-v2': ['schemaVersion', 'tool', 'artifacts', 'rule', 'prose', 'evidenceProperties', 'provenance'],
  'n8n-scan-profiles-v2': ['schemaVersion', 'tool', 'profiles'],
  'n8n-scan-version-v2': ['schemaVersion', 'name', 'cliVersion', 'engine', 'resultSchemas', 'configSchema', 'rulesetDigest', 'semanticsDigest', 'trustStoreDigest', 'mode'],
  'n8n-scan-config-validation-v2': ['schemaVersion', 'valid', 'artifacts'],
  tool: ['name', 'version', 'buildDigest'], artifacts: ['profile', 'ruleset', 'semantics', 'target', 'limits'],
  profileId: ['id', 'version'], ruleset: ['id', 'version', 'digest', 'signatureStatus'], semantics: ['id', 'version', 'digest'],
  target: ['schemaVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'],
  limits: ['schemaVersion', 'digest'], rule: ['ruleId', 'revision', 'effect', 'severity', 'confidence', 'capabilityId', 'evidenceSchemaId', 'remediationId', 'cweIds', 'owaspAgenticIds'],
  prose: ['title', 'message', 'explanation', 'whyItMatters', 'possibleImpact', 'remediation', 'remediationSteps'],
  provenance: ['packDigest', 'semanticsDigest'], profile: ['id', 'version', 'admitted', 'advertised', 'digest', 'scoringPolicyVersion', 'capabilities'],
  capability: ['id', 'version', 'required', 'dependsOn', 'ruleIds'], engine: ['id', 'version', 'buildDigest'],
};
const DIGEST = /^[0-9a-f]{64}$/;
const fail = (): never => { throw new TypeError('Invalid metadata document'); };

export function checkPlain(o: unknown): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return fail();
  if (Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null) return fail();
  if (Object.getOwnPropertySymbols(o).length > 0) return fail();
  for (const key of Object.getOwnPropertyNames(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
  }
  return o as Record<string, unknown>;
}

export function checkDenseArray<T>(arr: unknown): T[] {
  if (!Array.isArray(arr) || Object.getPrototypeOf(arr) !== Array.prototype || Object.getOwnPropertySymbols(arr).length > 0) return fail();
  const names = Object.getOwnPropertyNames(arr);
  if (names.length !== arr.length + 1) return fail();
  for (const name of names) {
    if (name === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= arr.length) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(arr, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
  }
  const length = Object.getOwnPropertyDescriptor(arr, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) return fail();
  return arr as T[];
}

function safeString(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f\ud800-\udfff]/.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[A-Za-z]:[\\/]|^\/|^\\\\/.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return fail();
}

function walk(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null) return;
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value !== 'object') return fail();
  if (seen.has(value)) return fail();
  seen.add(value);
  if (Array.isArray(value)) for (const item of checkDenseArray<unknown>(value)) walk(item, seen);
  else for (const item of Object.values(checkPlain(value))) walk(item, seen);
  seen.delete(value);
}

function checkKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const object = checkPlain(value); const actual = Object.keys(object);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return fail();
  return object;
}
function digest(value: unknown): void { if (typeof value !== 'string' || !DIGEST.test(value)) fail(); }
function sortedStrings(value: unknown): void {
  const values = checkDenseArray<unknown>(value);
  if (values.some((item) => typeof item !== 'string')) return fail();
  for (let i = 1; i < values.length; i += 1) if (compareCanonicalStrings(values[i - 1] as string, values[i] as string) >= 0) return fail();
}
function artifacts(value: unknown): void {
  const object = checkKeys(value, KEYS.artifacts!);
  checkKeys(object.profile, KEYS.profileId!);
  const ruleset = checkKeys(object.ruleset, KEYS.ruleset!);
  digest(ruleset.digest); if (ruleset.signatureStatus !== 'VERIFIED' && ruleset.signatureStatus !== 'UNVERIFIED') return fail();
  checkKeys(object.semantics, KEYS.semantics!);
  const target = checkKeys(object.target, KEYS.target!);
  if (target.schemaVersion !== 'scanner-target-v3') fail(); checkDenseArray(target.communityPackages); checkDenseArray(target.configuration); digest(target.contextDigest);
  const limits = checkKeys(object.limits, KEYS.limits!); if (limits.schemaVersion !== 'scanner-limits-v2') return fail(); digest(limits.digest);
}
function exact(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => exact(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return Object.is(left, right);
  const a = Object.keys(left as object); const b = Object.keys(right as object);
  return a.length === b.length && a.every((key, index) => key === b[index] && exact((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function authority(schema: string, root: Record<string, unknown>): CliMetadataDocumentV2 {
  if (schema === 'n8n-scan-rules-v2') return rulesDocumentV2();
  if (schema === 'n8n-scan-explain-v2') {
    const result = explainDocumentV2(String((root.rule as Record<string, unknown>).ruleId));
    if (!result.ok) return fail();
    return result.document;
  }
  if (schema === 'n8n-scan-profiles-v2') return profilesDocumentV2();
  if (schema === 'n8n-scan-version-v2') return versionDocumentV2();
  const result = validateConfigDocumentV2({ schemaVersion: 'n8n-scan-config-v2' });
  if (!result.ok) return fail();
  return result.document;
}

export function validateDocumentShape(doc: unknown): asserts doc is CliMetadataDocumentV2 {
  walk(doc);
  const root = checkPlain(doc); const schema = root.schemaVersion;
  if (typeof schema !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, schema)) return fail();
  checkKeys(root, KEYS[schema]!);
  if (schema === 'n8n-scan-rules-v2') {
    checkKeys(root.tool, KEYS.tool!); artifacts(root.artifacts);
    const rules = checkDenseArray(root.rules); for (const rule of rules) { const item = checkKeys(rule, KEYS.rule!); sortedStrings(item.cweIds); sortedStrings(item.owaspAgenticIds); }
  } else if (schema === 'n8n-scan-explain-v2') {
    checkKeys(root.tool, KEYS.tool!); artifacts(root.artifacts); checkKeys(root.rule, KEYS.rule!); const prose = checkKeys(root.prose, KEYS.prose!); checkDenseArray(prose.remediationSteps); checkDenseArray(root.evidenceProperties); checkKeys(root.provenance, KEYS.provenance!);
  } else if (schema === 'n8n-scan-profiles-v2') {
    checkKeys(root.tool, KEYS.tool!); const profiles = checkDenseArray(root.profiles);
    for (const profile of profiles) { const item = checkKeys(profile, KEYS.profile!); for (const capability of checkDenseArray(item.capabilities)) { const value = checkKeys(capability, KEYS.capability!); checkDenseArray(value.dependsOn); checkDenseArray(value.ruleIds); } }
  } else if (schema === 'n8n-scan-version-v2') {
    checkKeys(root.engine, KEYS.engine!); checkDenseArray(root.resultSchemas); digest(root.rulesetDigest); digest(root.semanticsDigest); digest(root.trustStoreDigest);
  } else {
    if (root.valid !== true) return fail(); artifacts(root.artifacts);
  }
  if (!exact(root, authority(schema, root))) return fail();
}
