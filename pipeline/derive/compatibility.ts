import type { N8nCompatibility } from '@hub/contracts';
import type { CompatibilityTarget } from '../compatibility-types.js';

function nodesOf(workflow: unknown): Record<string, unknown>[] | null {
  if (!workflow || typeof workflow !== 'object') return null;
  const nodes = (workflow as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return null;
  return nodes.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object'));
}

function typeOf(node: Record<string, unknown>): string {
  return typeof node.type === 'string' ? node.type : '';
}

function hasLegacyExpression(value: unknown, depth = 0): boolean {
  if (typeof value === 'string' && value.includes('$node[')) return true;
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.slice(0, 200).some((item) => hasLegacyExpression(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).slice(0, 200).some(([key, item]) => key.includes('$node[') || hasLegacyExpression(item, depth + 1));
}

export function deriveCompatibility(workflow: unknown, target: CompatibilityTarget): N8nCompatibility {
  const base = { targetVersion: target.targetVersion, checkedAt: target.checkedAt, source: target.source };
  const nodes = nodesOf(workflow);
  if (!nodes || nodes.length === 0) {
    return { ...base, status: 'unknown', reasons: ['The workflow JSON does not contain a usable node list.'], blockers: ['Import and inspect the workflow in n8n before relying on it.'] };
  }

  const reasons = [`Compared with the n8n ${target.targetVersion} release snapshot.`];
  const blockers: string[] = [];
  let review = false;
  for (const node of nodes) {
    const type = typeOf(node);
    if (!type) {
      review = true;
      blockers.push('At least one node has no type identifier.');
      continue;
    }
    if (type === 'n8n-nodes-base.function' || type === 'n8n-nodes-base.functionItem') {
      review = true;
      blockers.push('The legacy Function node may need migration to Code.');
    }
    if (type.startsWith('n8n-nodes-base.') || type.startsWith('@n8n/')) {
      if (typeof node.typeVersion !== 'number' || !Number.isFinite(node.typeVersion)) review = true;
    } else {
      review = true;
      blockers.push(`Community node package requires verification: ${type.split('.').slice(0, -1).join('.') || type}.`);
    }
    if (hasLegacyExpression(node.parameters)) {
      review = true;
      blockers.push('Legacy $node[...] expressions require a migration review.');
    }
  }
  const uniqueBlockers = [...new Set(blockers)].slice(0, 8);
  if (uniqueBlockers.length > 0) reasons.push('The static check found signals that deserve a manual import test.');
  else reasons.push('All node namespaces are part of n8n core or the maintained @n8n packages, with no legacy signal detected.');
  return { ...base, status: review ? 'review-required' : 'likely-compatible', reasons, blockers: uniqueBlockers };
}
