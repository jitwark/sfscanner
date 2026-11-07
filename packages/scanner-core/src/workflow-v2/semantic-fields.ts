import type { SourceObjectMemberV2, SourceValueV2 } from '../source/source-types';
import { classifySecretValue } from '../secret-classifier';
import type { SemanticClassification, SemanticFieldV2 } from './security-workflow';

export type SemanticRegion = 'ROOT' | 'PARAMETERS' | 'CREDENTIALS' | 'SETTINGS' | 'CONNECTIONS' | 'METADATA';

const CODE_NAMES = new Set([
  'code', 'jscode', 'pythoncode', 'functioncode', 'function', 'script', 'sourcecode',
]);

export function semanticFields(value: SourceValueV2, region: SemanticRegion = 'METADATA'): SemanticFieldV2[] {
  if (value.kind === 'OBJECT') return value.members.map((member) => fieldFromMember(member, region));
  if (value.kind === 'ARRAY') return value.items.map((item) => fieldFromValue(item, region));
  return [fieldFromValue(value, region)];
}

export function fieldFromMember(member: SourceObjectMemberV2, region: SemanticRegion): SemanticFieldV2 {
  const childRegion = regionFor(member.name, region);
  return Object.freeze({
    pointer: member.ref.pointer,
    occurrences: Object.freeze([member.ref]),
    value: valueFor(member.value, childRegion),
    classification: classify(member.name, member.value, childRegion),
  });
}

function fieldFromValue(value: SourceValueV2, region: SemanticRegion): SemanticFieldV2 {
  return Object.freeze({
    pointer: value.ref.pointer,
    occurrences: Object.freeze([value.ref]),
    value: valueFor(value, region),
    classification: classify(undefined, value, region),
  });
}

function valueFor(value: SourceValueV2, region: SemanticRegion): SemanticFieldV2['value'] {
  if (value.kind === 'NULL' || value.kind === 'BOOLEAN' || value.kind === 'STRING') return value.value;
  if (value.kind === 'NUMBER') {
    if (!Number.isFinite(value.value)) throw new TypeError('Non-finite semantic number');
    return value.value;
  }
  if (value.kind === 'ARRAY') return Object.freeze(value.items.map((item) => fieldFromValue(item, region)));
  return Object.freeze(value.members.map((member) => fieldFromMember(member, region)));
}

function regionFor(name: string, parent: SemanticRegion): SemanticRegion {
  const normalized = name.toLowerCase();
  if (normalized === 'parameters') return 'PARAMETERS';
  if (normalized === 'credentials' || normalized.includes('credential')) return 'CREDENTIALS';
  if (normalized === 'settings') return 'SETTINGS';
  if (normalized === 'connections') return 'CONNECTIONS';
  if (parent === 'PARAMETERS' || parent === 'CREDENTIALS' || parent === 'SETTINGS' || parent === 'CONNECTIONS') return parent;
  return 'METADATA';
}

function classify(name: string | undefined, value: SourceValueV2, region: SemanticRegion): SemanticClassification {
  if (region === 'CREDENTIALS' || (name !== undefined && /credential/i.test(name))) return 'CREDENTIAL_REF';
  if (value.kind === 'STRING' && containsExpression(value.value)) return 'EXPRESSION';
  if (name !== undefined && CODE_NAMES.has(name.toLowerCase())) return 'CODE';
  if (name !== undefined && isSensitiveName(name)) return 'SECRET_CANDIDATE';
  if (value.kind === 'STRING' && classifySecretValue(value.value, name)) return 'SECRET_CANDIDATE';
  return 'PLAIN';
}

function containsExpression(value: string): boolean {
  const start = value.indexOf('={{');
  return start >= 0 && value.indexOf('}}', start + 3) >= 0;
}

function isSensitiveName(name: string): boolean {
  return /(?:password|passphrase|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)/i.test(name);
}
