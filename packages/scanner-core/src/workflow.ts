import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from './canonical-json';
import { toJsonPointer } from './json-pointer';
import { exceedsNestingDepth, exceedsParameterBudget } from './workflow-budgets';
import { exceedsJsonDocumentDepth, MAX_SOURCE_PARSER_DEPTH } from './source/source-preflight';
import {
  collectParseDiagnostics,
  type MalformedNodeParametersLocation,
  type WorkflowParseDiagnostic,
} from './workflow-diagnostics';
import { buildWorkflowGraph, type WorkflowGraph } from './workflow-graph';
import {
  DuplicateKeyLocationLimitError,
  parseWorkflowSource,
  type DuplicateJsonKeyLocation,
  type SourceSpan,
} from './workflow-source-locations';

export { toJsonPointer };
export type { SourceSpan } from './workflow-source-locations';

export type WorkflowParseErrorCode =
  | 'INVALID_JSON'
  | 'MALFORMED_WORKFLOW'
  | 'WORKFLOW_TOO_LARGE'
  | 'WORKFLOW_TOO_COMPLEX';

/**
 * Which budget or parser-safety boundary a `WORKFLOW_TOO_COMPLEX` rejection
 * actually violated. A closed
 * union — one member per rejection site below — so consumers (the scan
 * worker's error mapping in particular) can switch over it exhaustively
 * instead of substring-matching the human-readable `message`.
 */
export type WorkflowTooComplexCause =
  | 'NODE_LIMIT'
  | 'EDGE_LIMIT'
  | 'CONNECTION_DEPTH_LIMIT'
  | 'PARAMETER_COMPLEXITY_LIMIT'
  | 'DOCUMENT_DEPTH_LIMIT'
  | 'DUPLICATE_KEY_LOCATION_LIMIT';

export type NormalizedWorkflowNode = {
  id: string;
  name: string;
  type: string;
  typeVersion?: string | number;
  parameters: Record<string, unknown>;
  sourcePath: string;
  sourceSpan?: SourceSpan;
};

export type NormalizedWorkflow = {
  name?: string;
  fingerprint: string;
  payloadBytes: number;
  nodeCount: number;
  nodes: NormalizedWorkflowNode[];
  connections: Record<string, unknown>;
  parseDiagnostics: WorkflowParseDiagnostic[];
  graph: WorkflowGraph;
};

export type WorkflowParseResult =
  | { ok: true; workflow: NormalizedWorkflow }
  | { ok: false; code: 'WORKFLOW_TOO_COMPLEX'; cause: WorkflowTooComplexCause; message: string }
  | { ok: false; code: Exclude<WorkflowParseErrorCode, 'WORKFLOW_TOO_COMPLEX'>; message: string };

export type WorkflowParseOptions = {
  maxBytes: number;
  maxNodes: number;
  maxConnectionDepth: number;
  maxParameterDepth: number;
  maxParameterLeaves: number;
  maxEdges: number;
};

/** Frozen locally to keep scanner-core browser-safe and free of a contracts runtime dependency. */
export const DEFAULT_WORKFLOW_PARSE_OPTIONS: WorkflowParseOptions = Object.freeze({
  maxBytes: 1_536_000,
  maxNodes: 5_000,
  maxEdges: 10_000,
  maxConnectionDepth: 64,
  maxParameterDepth: 64,
  maxParameterLeaves: 10_000,
});

export function parseWorkflowJson(
  workflowJson: string,
  options: Partial<WorkflowParseOptions> = {},
): WorkflowParseResult {
  const effectiveOptions: WorkflowParseOptions = {
    maxBytes: options.maxBytes ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxBytes,
    maxNodes: options.maxNodes ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxNodes,
    maxConnectionDepth: options.maxConnectionDepth ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxConnectionDepth,
    maxParameterDepth: options.maxParameterDepth ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxParameterDepth,
    maxParameterLeaves: options.maxParameterLeaves ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxParameterLeaves,
    maxEdges: options.maxEdges ?? DEFAULT_WORKFLOW_PARSE_OPTIONS.maxEdges,
  };
  const byteLength = new TextEncoder().encode(workflowJson).length;
  if (byteLength > effectiveOptions.maxBytes) {
    return { ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow JSON exceeds the configured payload limit.' };
  }
  if (exceedsJsonDocumentDepth(workflowJson, MAX_SOURCE_PARSER_DEPTH)) {
    return workflowTooComplex('document depth limit', 'DOCUMENT_DEPTH_LIMIT');
  }

  let parsed: unknown;
  let nodeSpans: Array<SourceSpan | undefined>;
  let duplicateKeys: DuplicateJsonKeyLocation[];
  try {
    ({ value: parsed, nodeSpans, duplicateKeys } = parseWorkflowSource(workflowJson));
  } catch (error) {
    if (error instanceof DuplicateKeyLocationLimitError) {
      return workflowTooComplex('duplicate-key source location output limit', 'DUPLICATE_KEY_LOCATION_LIMIT');
    }
    return { ok: false, code: 'INVALID_JSON', message: 'Workflow JSON is not valid JSON.' };
  }

  if (!isRecord(parsed)) return malformedWorkflow('Workflow JSON must be an object.');
  const nodes = parsed.nodes;
  const connections = parsed.connections;
  if (!Array.isArray(nodes) || !isRecord(connections)) {
    return malformedWorkflow('Workflow JSON must include nodes array and connections object.');
  }
  if (nodes.length > effectiveOptions.maxNodes) {
    return workflowTooComplex('node limit', 'NODE_LIMIT');
  }
  if (exceedsNestingDepth(connections, effectiveOptions.maxConnectionDepth)) {
    return workflowTooComplex('connection nesting limit', 'CONNECTION_DEPTH_LIMIT');
  }

  const normalizedNodes: NormalizedWorkflowNode[] = [];
  const malformedParameters: MalformedNodeParametersLocation[] = [];
  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isRecord(node) || typeof node.name !== 'string' || typeof node.type !== 'string') {
      return malformedWorkflow('Each workflow node must include string name and type fields.');
    }
    const parameters = isRecord(node.parameters) ? node.parameters : {};
    if ('parameters' in node && !isRecord(node.parameters)) {
      malformedParameters.push({ nodeIndex, pointer: toJsonPointer(['nodes', nodeIndex, 'parameters']) });
    }
    if (exceedsParameterBudget(parameters, {
      maxDepth: effectiveOptions.maxParameterDepth,
      maxLeaves: effectiveOptions.maxParameterLeaves,
    })) return workflowTooComplex('parameter complexity limit', 'PARAMETER_COMPLEXITY_LIMIT');

    normalizedNodes.push({
      id: typeof node.id === 'string' ? node.id : node.name,
      name: node.name,
      type: node.type,
      typeVersion: normalizeTypeVersion(node.typeVersion),
      parameters,
      sourcePath: toJsonPointer(['nodes', nodeIndex]),
      ...(nodeSpans[nodeIndex] ? { sourceSpan: nodeSpans[nodeIndex] } : {}),
    });
  }

  const graph = buildWorkflowGraph(normalizedNodes, connections, { maxEdges: effectiveOptions.maxEdges });
  if (graph.limitExceeded) return workflowTooComplex('edge limit', 'EDGE_LIMIT');

  return {
    ok: true,
    workflow: {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      fingerprint: fingerprintJson(parsed),
      payloadBytes: byteLength,
      nodeCount: normalizedNodes.length,
      nodes: normalizedNodes,
      connections,
      parseDiagnostics: collectParseDiagnostics(normalizedNodes, duplicateKeys, malformedParameters),
      graph,
    },
  };
}

function malformedWorkflow(message: string): WorkflowParseResult {
  return { ok: false, code: 'MALFORMED_WORKFLOW', message };
}

function workflowTooComplex(limit: string, cause: WorkflowTooComplexCause): WorkflowParseResult {
  return {
    ok: false,
    code: 'WORKFLOW_TOO_COMPLEX',
    cause,
    message: `Workflow JSON exceeds the configured ${limit}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTypeVersion(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

export function fingerprintJson(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(value))));
}
