import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../semantics/builtin-catalogue';
import { resolveNodeSemanticsForScan } from '../../semantics/generic-fallback';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { scanWorkflowV2 } from '../../v2/index';
import { scanWorkflowDormantHardenedV2 } from '../../v2/scan-workflow';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';

export const profile = { id: 'beta-default', version: '2.0.0' } as const;
export const variants = [
  { name: 'command', type: 'executeCommand', versions: [1], parameter: 'command', sinkClass: 'COMMAND', extra: {} },
  { name: 'URL', type: 'httpRequest', versions: [3, 4, 4.1, 4.2, 4.3, 4.4], parameter: 'url', sinkClass: 'SSRF', extra: {} },
  { name: 'Postgres SQL', type: 'postgres', versions: [2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6],
    parameter: 'query', sinkClass: 'SQL', extra: { resource: 'database', operation: 'executeQuery' } },
  { name: 'MySQL SQL', type: 'mySql', versions: [2, 2.1, 2.2, 2.3, 2.4, 2.5],
    parameter: 'query', sinkClass: 'SQL', extra: { resource: 'database', operation: 'executeQuery' } },
  { name: 'read path', type: 'readBinaryFile', versions: [1], parameter: 'filePath', sinkClass: 'PATH', extra: {} },
  { name: 'write path', type: 'writeBinaryFile', versions: [1], parameter: 'fileName', sinkClass: 'PATH', extra: {} },
] as const;
export type Variant = (typeof variants)[number];
export function workflowFor(variant: Variant, version: number = variant.versions[0], parameters?: Record<string, unknown>) {
  const sourceField = variant.sinkClass === 'COMMAND' ? 'cmd' : 'selected';
  return { nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [0, 0], parameters: { httpMethod: 'POST', path: 'input' } },
    { id: 'sink', name: 'Sink', type: `n8n-nodes-base.${variant.type}`, typeVersion: version,
      position: [1, 0], parameters: parameters ?? { ...variant.extra, [variant.parameter]: `={{ $json.body.${sourceField} }}` } },
  ], connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } } };
}
export const encode = (workflow: unknown) => new TextEncoder().encode(JSON.stringify(workflow));
export function publicScan(workflow: unknown, maxGraphOperations = 100_000) {
  const result = scanWorkflowV2({ bytes: encode(workflow), profile, limits: { maxGraphOperations } });
  if (!result.ok) throw new Error(result.code);
  return result.result;
}
export function dormantScan(workflow: unknown) {
  const result = scanWorkflowDormantHardenedV2({ bytes: encode(workflow), profile });
  if (!result.ok) throw new Error(result.code);
  return result;
}
export function compileFixture(workflow: unknown, allowance = 100_000) {
  const parsed = parseSourceDocument(encode(workflow), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error(parsed.message);
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error(normalized.message);
  const resolved = new Map<string, ResolvedNodeSemanticsV2>();
  for (const node of normalized.workflow.nodes) {
    const result = resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
    if (result) resolved.set(node.ref.identityDigest, result.semantics);
  }
  const semantics = { ...BUILTIN_SEMANTIC_CATALOGUE_V2, resolvedNodeSemantics: resolved };
  let used = 0;
  let refused = false;
  const charge = (units: number) => {
    if (refused || units > allowance - used) { refused = true; return false; }
    used += units; return true;
  };
  const input = { workflow: normalized.workflow, semantics, charge };
  return { ...input, used: () => used, model: compileScanLocalWorkflowFlowModelV1(input) };
}
