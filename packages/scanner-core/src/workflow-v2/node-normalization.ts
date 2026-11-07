import type { ScannerLimitsV2 } from '@hub/contracts';
import type { SourceObjectMemberV2, SourceValueV2 } from '../source/source-types';
import { createAmbiguity } from './ambiguity';
import { createNodeRef } from './node-edge-identity';
import { hasDuplicateMembers } from './duplicate-ambiguities';
import { fieldFromMember, semanticFields } from './semantic-fields';
import type { NormalizationAmbiguityV2, SecurityNodeV2, NodeRefV2 } from './security-workflow';

type NodeCollection = {
  nodes: SecurityNodeV2[];
  refs: NodeRefV2[];
  ambiguities: NormalizationAmbiguityV2[];
  parameterDepth: number;
  parameterLeaves: number;
  error?: 'MALFORMED_WORKFLOW' | 'NODE_LIMIT' | 'PARAMETER_DEPTH_LIMIT' | 'PARAMETER_LEAF_LIMIT';
};

const CORE_NODE_MEMBERS = new Set(['type', 'disabled', 'parameters', 'credentials', 'settings']);

export function normalizeNodes(
  value: SourceValueV2,
  limits: ScannerLimitsV2,
  ordinalOffset = 0,
): NodeCollection {
  const result: NodeCollection = { nodes: [], refs: [], ambiguities: [], parameterDepth: 0, parameterLeaves: 0 };
  if (value.kind !== 'ARRAY') return { ...result, error: 'MALFORMED_WORKFLOW' };

  for (const [ordinal, item] of value.items.entries()) {
    if (item.kind !== 'OBJECT') return { ...result, error: 'MALFORMED_WORKFLOW' };
    const typeMembers = membersNamed(item, 'type');
    const type = effectiveMember(item, 'type');
    const typeValue = type?.value;
    if (typeMembers.length === 0 || (typeMembers.length === 1 && (typeValue?.kind !== 'STRING' || typeValue.value.length === 0))) {
      return { ...result, error: 'MALFORMED_WORKFLOW' };
    }
    const id = effectiveMember(item, 'id');
    const name = effectiveMember(item, 'name');
    const idMembers = membersNamed(item, 'id');
    const nameMembers = membersNamed(item, 'name');
    const nodeRef = createNodeRef({
      ordinal: ordinalOffset + ordinal,
      source: item.ref,
      explicitId: idMembers.length === 1 && id?.value.kind === 'STRING' ? id.value.value : undefined,
      name: nameMembers.length === 1 && name?.value.kind === 'STRING' ? name.value.value : undefined,
    });
    const parameterFields: ReturnType<typeof semanticFields> = [];
    let scoringEligibility: SecurityNodeV2['scoringEligibility'] = typeMembers.length > 1 ? 'INDETERMINATE' : 'ELIGIBLE';
    if (hasDuplicateMembers(item, limits.maxMembersAndElements)) scoringEligibility = 'INDETERMINATE';
    if (idMembers.length > 1 || nameMembers.length > 1) scoringEligibility = 'INDETERMINATE';
    const parameterMembers = membersNamed(item, 'parameters');
    if (parameterMembers.length > 1) scoringEligibility = 'INDETERMINATE';
    for (const parameters of parameterMembers) {
      if (parameters.value.kind !== 'OBJECT') scoringEligibility = 'INDETERMINATE';
      const normalized = normalizeParameterFields(parameters, limits, result);
      if (normalized.error) return { ...result, error: normalized.error };
      parameterFields.push(...normalized.fields);
    }
    const credentialsMembers = membersNamed(item, 'credentials');
    if (credentialsMembers.length > 1 || credentialsMembers.some((member) => member.value.kind !== 'OBJECT')) scoringEligibility = 'INDETERMINATE';
    const credentials = normalizeRegionFields(item, 'credentials', result);
    const settings = normalizeSettings(item, result);
    const disabled = effectiveMember(item, 'disabled');
    const disabledMembers = membersNamed(item, 'disabled');
    const typeVersionMembers = membersNamed(item, 'typeVersion');
    if (disabledMembers.length > 1 || (disabled && disabled.value.kind !== 'BOOLEAN')) {
      scoringEligibility = 'INDETERMINATE';
      if (disabled && disabled.value.kind !== 'BOOLEAN') result.ambiguities.push(createAmbiguity({
        kind: 'MALFORMED_SECURITY_VALUE', subject: disabled.ref, securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
      }));
    }
    if (typeVersionMembers.length > 1) scoringEligibility = 'INDETERMINATE';
    const typeVersionMember = effectiveMember(item, 'typeVersion');
    const typeVersion = normalizedTypeVersion(typeVersionMember);
    if (typeVersionMember && typeVersion === undefined) result.ambiguities.push(createAmbiguity({
      kind: 'MALFORMED_SECURITY_VALUE', subject: typeVersionMember.ref, securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
    }));
    if (typeVersionMember && typeVersion === undefined) scoringEligibility = 'INDETERMINATE';
    if (membersNamed(item, 'settings').length > 1 || membersNamed(item, 'settings').some((member) => member.value.kind !== 'OBJECT')) scoringEligibility = 'INDETERMINATE';
    const node: SecurityNodeV2 = Object.freeze({
      ref: nodeRef,
      type: typeMembers.length > 1 ? '' : typeValue?.kind === 'STRING' ? typeValue.value : '',
      ...(typeVersion === undefined ? {} : { typeVersion }),
      disabled: disabled?.value.kind === 'BOOLEAN' ? disabled.value.value : false,
      scoringEligibility,
      parameters: Object.freeze(parameterFields),
      credentials: Object.freeze(credentials),
      settings: Object.freeze(settings),
    });
    result.nodes.push(node);
    result.refs.push(nodeRef);
  }
  return result;
}

function normalizedTypeVersion(member: SourceObjectMemberV2 | undefined): string | undefined {
  if (!member) return undefined;
  const value = member.value;
  if (value.kind === 'STRING') {
    const raw = value.value;
    if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,2}$/.test(raw)) return raw;
    const parts = raw.split('.');
    return parts.concat(Array(3 - parts.length).fill('0')).join('.');
  }
  if (value.kind !== 'NUMBER' || !Number.isFinite(value.value) || value.value < 0) return undefined;
  const numeric = String(value.value);
  if (/^\d+$/.test(numeric)) return `${numeric}.0.0`;
  if (/^\d+\.\d+$/.test(numeric)) return `${numeric}.0`;
  return undefined;
}

function normalizeParameterFields(member: SourceObjectMemberV2 | undefined, limits: ScannerLimitsV2, result: NodeCollection) {
  if (!member) return { fields: [] as ReturnType<typeof semanticFields> };
  if (member.value.kind !== 'OBJECT') {
    result.ambiguities.push(createAmbiguity({
      kind: 'MALFORMED_SECURITY_VALUE', subject: member.ref, securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
    }));
    return { fields: [] as ReturnType<typeof semanticFields> };
  }
  const budget = parameterBudget(member.value, limits.maxParameterDepth, limits.maxParameterLeaves);
  result.parameterDepth = Math.max(result.parameterDepth, budget.depth);
  result.parameterLeaves += budget.leaves;
  if (budget.depthExceeded) return { fields: [], error: 'PARAMETER_DEPTH_LIMIT' as const };
  if (budget.leafExceeded) return { fields: [], error: 'PARAMETER_LEAF_LIMIT' as const };
  return { fields: semanticFields(member.value, 'PARAMETERS') };
}

function normalizeRegionFields(value: Extract<SourceValueV2, { kind: 'OBJECT' }>, name: string, result: NodeCollection) {
  const fields: ReturnType<typeof semanticFields> = [];
  for (const member of membersNamed(value, name)) {
    if (member.value.kind === 'OBJECT') fields.push(...semanticFields(member.value, 'CREDENTIALS'));
    else {
      result.ambiguities.push(createAmbiguity({
        kind: 'MALFORMED_SECURITY_VALUE', subject: member.ref, securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
      }));
      fields.push(fieldFromMember(member, 'CREDENTIALS'));
    }
  }
  return fields;
}

function normalizeSettings(value: Extract<SourceValueV2, { kind: 'OBJECT' }>, result: NodeCollection) {
  const fields = value.members
    .filter((member) => !CORE_NODE_MEMBERS.has(member.name.toLowerCase()))
    .map((member) => fieldFromMember(member, 'SETTINGS'));
  for (const member of membersNamed(value, 'settings')) {
    if (member.value.kind === 'OBJECT') fields.push(...semanticFields(member.value, 'SETTINGS'));
    else {
      result.ambiguities.push(createAmbiguity({
        kind: 'MALFORMED_SECURITY_VALUE', subject: member.ref, securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
      }));
      fields.push(fieldFromMember(member, 'SETTINGS'));
    }
  }
  return fields;
}

function membersNamed(value: Extract<SourceValueV2, { kind: 'OBJECT' }>, name: string): SourceObjectMemberV2[] {
  return value.members.filter((member) => member.name === name);
}

function parameterBudget(value: SourceValueV2, maxDepth: number, maxLeaves: number) {
  const pending: Array<{ value: SourceValueV2; depth: number }> = [{ value, depth: 0 }];
  let depth = 0;
  let leaves = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    depth = Math.max(depth, current.depth);
    if (current.depth > maxDepth) return { depth, leaves, depthExceeded: true, leafExceeded: false };
    if (current.value.kind === 'OBJECT') {
      for (const member of current.value.members) pending.push({ value: member.value, depth: current.depth + 1 });
    } else if (current.value.kind === 'ARRAY') {
      for (const item of current.value.items) pending.push({ value: item, depth: current.depth + 1 });
    } else {
      leaves += 1;
      if (leaves > maxLeaves) return { depth, leaves, depthExceeded: false, leafExceeded: true };
    }
  }
  return { depth, leaves, depthExceeded: false, leafExceeded: false };
}

function effectiveMember(value: Extract<SourceValueV2, { kind: 'OBJECT' }>, name: string) {
  for (let index = value.members.length - 1; index >= 0; index -= 1) {
    if (value.members[index].name === name) return value.members[index];
  }
  return undefined;
}
