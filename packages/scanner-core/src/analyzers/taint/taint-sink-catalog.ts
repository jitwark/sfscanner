import type { NormalizedWorkflowNode } from '../../workflow';
import type { ScanSeverity } from '../../policy/policy';
import type { TaintSinkKind } from './taint-lattice';
import type { TaintPolicyId } from '../../policy/rule-catalog';

export type SinkCatalogEntry = {
  nodeTypes: readonly string[];
  parameterPaths: readonly string[];
  sink: TaintSinkKind;
  policyId: TaintPolicyId;
  severity: ScanSeverity;
};

export type SinkRead = {
  sink: TaintSinkKind;
  policyId: TaintPolicyId;
  severity: ScanSeverity;
  parameterPath: string;
  value: string;
};

export const TAINT_SINK_CATALOG: readonly SinkCatalogEntry[] = [
  { nodeTypes: ['n8n-nodes-base.executeCommand'], parameterPaths: ['command'], sink: 'COMMAND', policyId: 'TAINTED_COMMAND', severity: 'CRITICAL' },
  { nodeTypes: ['n8n-nodes-base.postgres', 'n8n-nodes-base.mySql', 'n8n-nodes-base.microsoftSql'], parameterPaths: ['query'], sink: 'SQL', policyId: 'TAINTED_SQL_QUERY', severity: 'HIGH' },
  { nodeTypes: ['n8n-nodes-base.httpRequest'], parameterPaths: ['url'], sink: 'SSRF', policyId: 'TAINTED_REQUEST_URL', severity: 'HIGH' },
  { nodeTypes: ['n8n-nodes-base.httpRequest'], parameterPaths: ['headerParameters.parameters[*].value'], sink: 'HEADER', policyId: 'TAINTED_REQUEST_HEADER', severity: 'MEDIUM' },
  { nodeTypes: ['n8n-nodes-base.readWriteFile', 'n8n-nodes-base.readBinaryFile', 'n8n-nodes-base.writeBinaryFile'], parameterPaths: ['fileSelector', 'fileName', 'filePath'], sink: 'PATH', policyId: 'TAINTED_FILE_PATH', severity: 'HIGH' },
  { nodeTypes: ['n8n-nodes-base.code', 'n8n-nodes-base.function', 'n8n-nodes-base.functionItem'], parameterPaths: ['jsCode', 'pythonCode', 'functionCode'], sink: 'CODE', policyId: 'TAINTED_CODE_INPUT', severity: 'HIGH' },
  { nodeTypes: ['@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.chainLlm'], parameterPaths: ['text', 'prompt'], sink: 'PROMPT', policyId: 'TAINTED_AI_PROMPT', severity: 'MEDIUM' },
];

export function collectSinkReads(node: NormalizedWorkflowNode): SinkRead[] {
  return TAINT_SINK_CATALOG
    .filter((entry) => entry.nodeTypes.includes(node.type))
    .flatMap((entry) => entry.parameterPaths.flatMap((pattern) => resolvePattern(node.parameters, pattern)
      .map(({ parameterPath, value }) => ({
        sink: entry.sink,
        policyId: entry.policyId,
        severity: entry.severity,
        parameterPath,
        value,
      }))));
}

function resolvePattern(parameters: Record<string, unknown>, pattern: string): Array<{ parameterPath: string; value: string }> {
  return pattern.split('.').reduce<Array<{ parameterPath: string; value: unknown }>>(
    (candidates, segment) => candidates.flatMap((candidate) => descend(candidate, segment)),
    [{ parameterPath: '', value: parameters }],
  ).flatMap(({ parameterPath, value }) => typeof value === 'string' ? [{ parameterPath, value }] : []);
}

function descend(candidate: { parameterPath: string; value: unknown }, segment: string): Array<{ parameterPath: string; value: unknown }> {
  const wildcard = segment.endsWith('[*]');
  const key = wildcard ? segment.slice(0, -3) : segment;
  if (!isRecord(candidate.value)) return [];
  const child = candidate.value[key];
  const path = candidate.parameterPath === '' ? key : `${candidate.parameterPath}.${key}`;
  if (!wildcard) return child === undefined ? [] : [{ parameterPath: path, value: child }];
  if (!Array.isArray(child)) return [];
  return child.map((element, index) => ({ parameterPath: `${path}[${index}]`, value: element }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
