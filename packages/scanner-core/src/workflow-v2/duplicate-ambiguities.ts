import type { ReadonlySourceDocumentV2, SourceMemberRefV2, SourceValueV2 } from '../source/source-types';
import { createAmbiguity } from './ambiguity';
import type { NormalizationAmbiguityV2, NormalizationSecurityImpact } from './security-workflow';

type Region = 'ROOT' | 'NODES' | 'NODE' | 'PARAMETERS' | 'CREDENTIALS' | 'SETTINGS' | 'CONNECTIONS' | 'METADATA';

export function collectDuplicateAmbiguities(source: ReadonlySourceDocumentV2): NormalizationAmbiguityV2[] {
  const ambiguities: NormalizationAmbiguityV2[] = [];
  visit(source.root, 'ROOT', ambiguities);
  return ambiguities;
}

export function hasDuplicateMembers(value: SourceValueV2, visitBudget: number): boolean {
  const pending: SourceValueV2[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > visitBudget) return true;
    if (current.kind === 'ARRAY') {
      for (const item of current.items) pending.push(item);
      continue;
    }
    if (current.kind !== 'OBJECT') continue;
    const names = new Set<string>();
    for (const member of current.members) {
      if (names.has(member.name)) return true;
      names.add(member.name);
      pending.push(member.value);
    }
  }
  return false;
}

function visit(value: SourceValueV2, region: Region, ambiguities: NormalizationAmbiguityV2[]): void {
  if (value.kind === 'ARRAY') {
    for (const item of value.items) visit(item, region === 'NODES' ? 'NODE' : region, ambiguities);
    return;
  }
  if (value.kind !== 'OBJECT') return;

  const byName = new Map<string, SourceMemberRefV2[]>();
  for (const member of value.members) {
    const refs = byName.get(member.name) ?? [];
    refs.push(member.ref);
    byName.set(member.name, refs);
  }
  for (const [name, refs] of byName) {
    if (refs.length < 2) continue;
    const memberRegion = childRegion(name, region);
    ambiguities.push(createAmbiguity({
      kind: 'DUPLICATE_MEMBER',
      subject: refs[0],
      related: refs.slice(1),
      securityImpact: duplicateImpact(name, memberRegion, region),
      resolution: 'RETAINED_ALL',
    }));
  }
  for (const member of value.members) visit(member.value, childRegion(member.name, region), ambiguities);
}

function childRegion(name: string, parent: Region): Region {
  const normalized = name.toLowerCase();
  if (parent === 'ROOT' && normalized === 'nodes') return 'NODES';
  if (parent === 'ROOT' && normalized === 'connections') return 'CONNECTIONS';
  if (parent === 'NODE' && normalized === 'parameters') return 'PARAMETERS';
  if (parent === 'NODE' && (normalized === 'credentials' || normalized.includes('credential'))) return 'CREDENTIALS';
  if (parent === 'NODE' && normalized === 'settings') return 'SETTINGS';
  if (parent === 'PARAMETERS' || parent === 'CREDENTIALS' || parent === 'SETTINGS' || parent === 'CONNECTIONS') return parent;
  if (parent === 'NODES') return 'NODE';
  return parent === 'ROOT' ? 'METADATA' : parent;
}

function duplicateImpact(name: string, memberRegion: Region, parent: Region): NormalizationSecurityImpact {
  const normalized = name.toLowerCase();
  if (memberRegion === 'NODES' || memberRegion === 'CONNECTIONS' ||
      (parent === 'NODE' && ['id', 'name'].includes(normalized))) return 'GRAPH_IDENTITY';
  if (memberRegion === 'PARAMETERS' || memberRegion === 'CREDENTIALS' || memberRegion === 'SETTINGS' ||
      ['active', 'disabled', 'type', 'typeversion', 'retryonfail', 'maxtries', 'waitbetweentries', 'onerror',
        'pindata', 'staticdata', 'trigger', 'tags', 'meta', 'credentials', 'settings', 'parameters'].includes(normalized)) {
    return 'SCORING_INPUT';
  }
  return 'METADATA_ONLY';
}
