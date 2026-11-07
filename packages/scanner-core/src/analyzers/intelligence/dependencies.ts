import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

export type DependencySummaryV1 = Readonly<{
  totalNodes: number;
  reviewedNodes: number;
  assumedNodes: number;
  unknownNodes: number;
  credentialReferences: number;
  requiredCredentialSlots: number;
  configuredCredentialSlots: number;
  missingCredentialSlots: number;
  unknownCredentialSlots: number;
  environmentReferences: number;
  redactedIdentifiers: number;
  omittedIdentifiers: number;
}>;
export type DependencyInputV1 = Readonly<{
  workflow: SecurityWorkflowV2;
  semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2>;
}>;

const ENV_REFERENCE = /\$env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gu;
const SENSITIVE_IDENTIFIER = /(?:api[_-]?key|password|passwd|secret|token|bearer|authorization|cookie|private[_-]?key)/iu;

/** Counts only: no credential id, value, or arbitrary identifier is published. */
export function summarizeDependencies(input: DependencyInputV1): DependencySummaryV1 {
  let reviewedNodes = 0;
  let assumedNodes = 0;
  let unknownNodes = 0;
  let credentialReferences = 0;
  let requiredCredentialSlots = 0;
  let configuredCredentialSlots = 0;
  let missingCredentialSlots = 0;
  let unknownCredentialSlots = 0;
  let environmentReferences = 0;
  let redactedIdentifiers = 0;
  for (let index = 0; index < input.workflow.nodes.length; index += 1) {
    const node = input.workflow.nodes[index]!;
    const semantics = input.semantics.get(node.ref.identityDigest);
    if (semantics === undefined || semantics.nodeType !== node.type) {
      unknownNodes += 1;
      environmentReferences += countEnvironmentReferences(node.parameters, (sensitive) => { if (sensitive) redactedIdentifiers += 1; });
      continue;
    }
    if (semantics.semanticId === 'generic.fallback') assumedNodes += 1;
    else {
      reviewedNodes += 1;
      credentialReferences += node.credentials.length;
      let typedRequired = 0;
      let unknown = 0;
      for (let pathIndex = 0; pathIndex < semantics.credentialPaths.length; pathIndex += 1) {
        const path = semantics.credentialPaths[pathIndex]!;
        if (/^\/credentials\/[^/]+$/u.test(path)) typedRequired += 1;
        else unknown += 1;
      }
      const configured = Math.min(node.credentials.length, typedRequired);
      requiredCredentialSlots += typedRequired + unknown;
      configuredCredentialSlots += configured;
      missingCredentialSlots += typedRequired - configured;
      unknownCredentialSlots += unknown;
    }
    environmentReferences += countEnvironmentReferences(node.parameters, (sensitive) => { if (sensitive) redactedIdentifiers += 1; });
  }
  return Object.freeze({
    totalNodes: input.workflow.nodes.length,
    reviewedNodes, assumedNodes, unknownNodes,
    credentialReferences, requiredCredentialSlots, configuredCredentialSlots,
    missingCredentialSlots, unknownCredentialSlots,
    environmentReferences, redactedIdentifiers, omittedIdentifiers: 0,
  });
}

function countEnvironmentReferences(value: unknown, onIdentifier: (sensitive: boolean) => void): number {
  const text = stringLeaves(value);
  let count = 0;
  for (const item of text) {
    if (!item.includes('{{')) continue;
    ENV_REFERENCE.lastIndex = 0;
    for (let match = ENV_REFERENCE.exec(item); match !== null; match = ENV_REFERENCE.exec(item)) {
      count += 1;
      onIdentifier(SENSITIVE_IDENTIFIER.test(match[1] ?? match[2] ?? ''));
    }
  }
  return count;
}

function stringLeaves(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 256 || output.length > 10_000) return output;
  if (typeof value === 'string') { output.push(value); return output; }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) stringLeaves(value[index], output, depth + 1);
    return output;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) stringLeaves(record[key], output, depth + 1);
  }
  return output;
}
