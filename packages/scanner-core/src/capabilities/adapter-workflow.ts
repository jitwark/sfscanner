import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../workflow';
import { buildWorkflowGraph } from '../workflow-graph';
import type { SourceValueV2 } from '../source/source-types';
import type { AnalyzerContextV2 } from './scheduler';
import type { SemanticFieldV2, SecurityNodeV2 } from '../workflow-v2/security-workflow';

type DataRecord = Record<string, unknown>;

export function toNativeWorkflow(context: AnalyzerContextV2): NormalizedWorkflow {
  const rawRoot = sourceValue(context.source.root);
  const root = record(rawRoot);
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const nodes = Array.prototype.map.call(context.workflow.nodes, (node: SecurityNodeV2) => nativeNode(node, rawNodes[node.ref.ordinal])) as NormalizedWorkflowNode[];
  const connections = record(root.connections);
  return {
    ...(typeof root.name === 'string' ? { name: root.name } : {}),
    fingerprint: context.source.rawSha256,
    payloadBytes: context.source.utf8Bytes,
    nodeCount: nodes.length,
    nodes,
    connections,
    parseDiagnostics: [],
    graph: buildWorkflowGraph(nodes, connections, { maxEdges: context.limits.maxEdges }),
  };
}

function nativeNode(node: SecurityNodeV2, raw: unknown): NormalizedWorkflowNode {
  const source = record(raw);
  const parameters = record(source.parameters);
  const fallback = fieldsObject(node.parameters);
  const value = Object.keys(parameters).length === 0 && node.parameters.length > 0 ? fallback : parameters;
  return {
    id: node.ref.explicitId ?? node.ref.name ?? String(node.ref.ordinal),
    name: node.ref.name ?? String(node.ref.ordinal),
    type: node.type,
    ...(node.typeVersion !== undefined ? { typeVersion: node.typeVersion } : {}),
    parameters: value,
    sourcePath: node.ref.source.pointer,
    ...(node.ref.source.span === null ? {} : { sourceSpan: {
      start: { line: node.ref.source.span.start.line, column: node.ref.source.span.start.column, offset: node.ref.source.span.start.utf16Offset },
      end: { line: node.ref.source.span.end.line, column: node.ref.source.span.end.column, offset: node.ref.source.span.end.utf16Offset },
    } }),
  };
}

function sourceValue(value: SourceValueV2): unknown {
  if (value.kind === 'NULL' || value.kind === 'BOOLEAN' || value.kind === 'NUMBER' || value.kind === 'STRING') return value.value;
  if (value.kind === 'ARRAY') {
    const items: unknown[] = []; for (let index = 0; index < value.items.length; index += 1) { const item = value.items[index]; if (item) items.push(sourceValue(item)); }
    return items;
  }
  const output = Object.create(null) as DataRecord;
  for (const member of value.members) output[member.name] = sourceValue(member.value);
  return output;
}

function record(value: unknown): DataRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : Object.create(null) as DataRecord;
}

function fieldsObject(fields: readonly SemanticFieldV2[]): DataRecord {
  const output = Object.create(null) as DataRecord;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]; if (field) output[fieldName(field.pointer)] = semanticValue(field.value);
  }
  return output;
}

function semanticValue(value: SemanticFieldV2['value']): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return [];
  const names: string[] = [];
  for (let index = 0; index < value.length; index += 1) { const field = value[index]; if (field) names.push(fieldName(field.pointer)); }
  if (names.every((name, index) => name === String(index))) {
    const items: unknown[] = []; for (let index = 0; index < value.length; index += 1) { const field = value[index]; if (field) items.push(semanticValue(field.value)); }
    return items;
  }
  const output = Object.create(null) as DataRecord;
  for (let index = 0; index < value.length; index += 1) { const field = value[index]; if (field) output[names[index] ?? String(index)] = semanticValue(field.value); }
  return output;
}

function fieldName(pointer: string): string {
  const segment = pointer.split('/').at(-1) ?? '';
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}
