import type { SecurityNodeV2 } from '../../workflow-v2/security-workflow';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { TAINTED_RULE_SINK_CLASSES_V1 } from '../../facts/safe-fact-registry';
import type { ScanLocalChargeV1 } from './scan-local-state';
import type { WorkflowFlowModelUnknownReasonV1 } from './scan-local-workflow-flow-model';
import { TAINT_SINK_CATALOG } from './taint-sink-catalog';

export type ReviewedFlowSinkV1 = Readonly<{
  sinkClass: 'COMMAND' | 'SQL' | 'SSRF' | 'PATH'; parameter: string;
}>;
type Selection = Readonly<{ status: 'SUPPORTED'; sink: ReviewedFlowSinkV1 }>
  | Readonly<{ status: 'UNKNOWN'; reason: WorkflowFlowModelUnknownReasonV1 }>
  | Readonly<{ status: 'LIMITED'; omittedLowerBound: number }>;
type Model = Readonly<{ nodeType: string; semanticId: string; digest: string;
  versions: readonly string[]; sinkClass: ReviewedFlowSinkV1['sinkClass']; parameter: string; effect: string }>;

// Exact node versions and reads from n8n-nodes-base@2.15.1, bound to reviewed source receipts.
// These terminal reads assert no downstream output preservation or actual external execution.
const MODELS: readonly Model[] = Object.freeze([
  { nodeType: 'n8n-nodes-base.httpRequest', semanticId: 'http-ai.http-request',
    digest: '11ace3d42311b7b95ee4bbb88ac8b33ef4d9446ebf55fcdff065f5627a92a87c',
    versions: ['3.0.0', '4.0.0', '4.1.0', '4.2.0', '4.3.0', '4.4.0'],
    sinkClass: 'SSRF', parameter: 'url', effect: 'READ_EXTERNAL' },
  { nodeType: 'n8n-nodes-base.postgres', semanticId: 'database-file.postgres',
    digest: '31da2afd8b00d8543d82093a39f9c4d6d82ad942707e274d5d03bf04a907f4ea',
    versions: ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0'],
    sinkClass: 'SQL', parameter: 'query', effect: 'DATABASE_READ' },
  { nodeType: 'n8n-nodes-base.mySql', semanticId: 'database-file.mysql',
    digest: '3b32421a9e2a1087eca6064cf2e0ed7e32c97cc128c36331fcac1a0e7dead6f6',
    versions: ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0'],
    sinkClass: 'SQL', parameter: 'query', effect: 'DATABASE_READ' },
  { nodeType: 'n8n-nodes-base.readBinaryFile', semanticId: 'database-file.read-binary-file',
    digest: '56525a3ebb326d7d4629d9a4c3192125179a9023e069cec344cf0b97c8b6c8fe',
    versions: ['1.0.0'], sinkClass: 'PATH', parameter: 'filePath', effect: 'READ_FILE' },
  { nodeType: 'n8n-nodes-base.writeBinaryFile', semanticId: 'database-file.write-binary-file',
    digest: '5f6e4f64a2636b8a77779ce8524a39a56df1337e7ac9d0474374025663db4ecc',
    versions: ['1.0.0'], sinkClass: 'PATH', parameter: 'fileName', effect: 'WRITE_FILE' },
]);
const unknown = (reason: WorkflowFlowModelUnknownReasonV1): Selection => ({ status: 'UNKNOWN', reason });
const limited = (): Selection => ({ status: 'LIMITED', omittedLowerBound: 1 });
const CATALOGUED_TYPES = new Set(TAINT_SINK_CATALOG.flatMap((entry) => entry.nodeTypes));

/** Caller prepays the finite catalog traversal before scanning nodes. */
export function isCataloguedFlowSinkV1(nodeType: string): boolean {
  return CATALOGUED_TYPES.has(nodeType);
}

export function selectReviewedFlowSinkV1(node: SecurityNodeV2, semantics: ResolvedNodeSemanticsV2 | undefined,
  charge: ScanLocalChargeV1): Selection {
  if (node.type === 'n8n-nodes-base.executeCommand') {
    return node.typeVersion === '1.0.0' ? { status: 'SUPPORTED', sink: { sinkClass: 'COMMAND', parameter: 'command' } }
      : unknown('UNSUPPORTED_VERSION');
  }
  if (!charge(1 + MODELS.length + node.parameters.length)) return limited();
  const model = MODELS.find((candidate) => candidate.nodeType === node.type);
  if (!model) return unknown('NO_REVIEWED_SINK_MODEL');
  if (!node.typeVersion || !model.versions.includes(node.typeVersion)) return unknown('UNSUPPORTED_VERSION');
  if (!semantics) return unknown('NO_REVIEWED_PAIR');
  if (!charge(3 + semantics.parameterPaths.length + semantics.endpoints.length + semantics.effects.length
    + semantics.ports.length + TAINT_SINK_CATALOG.length)) return limited();
  if (semantics.semanticId !== model.semanticId || semantics.provenance.sourceDigest !== model.digest
    || !semantics.effects.some((effect) => effect === model.effect)
    || semantics.parameterPaths.filter((field) => field.pointer === `/${model.parameter}`).length !== 1
    || semantics.endpoints.filter((endpoint) => endpoint.path === `/${model.parameter}`
      && endpoint.direction === 'SINK' && endpoint.channel === 'DATA').length !== 1
    || semantics.ports.length !== 1 || semantics.ports[0]?.type !== 'main'
    || semantics.ports[0].index !== 0 || semantics.ports[0].itemMode !== 'EACH') return unknown('NO_REVIEWED_PAIR');
  if (!TAINT_SINK_CATALOG.some((entry) => entry.nodeTypes.includes(node.type)
    && entry.parameterPaths.includes(model.parameter) && entry.sink === model.sinkClass
    && TAINTED_RULE_SINK_CLASSES_V1[entry.policyId] === model.sinkClass)) return unknown('NO_REVIEWED_PAIR');
  const prefix = `/nodes/${node.ref.ordinal}/parameters/`;
  const fields = new Map(node.parameters.map((field) => [field.pointer, field]));
  if (model.sinkClass === 'SQL') {
    for (const [key, expected] of [['resource', 'database'], ['operation', 'executeQuery']] as const) {
      const field = fields.get(prefix + key);
      if (!field) return unknown('NO_REVIEWED_PAIR');
      if (field.classification !== 'PLAIN' || typeof field.value !== 'string') return unknown('DYNAMIC_FIELD');
      if (field.value !== expected) return unknown('NO_REVIEWED_PAIR');
    }
  }
  // Header evaluation has no reviewed nested-field model. Do not silently hide it behind URL success.
  if (model.sinkClass === 'SSRF' && (fields.has(prefix + 'headerParameters')
    || fields.has(prefix + 'jsonHeaders') || fields.get(prefix + 'sendHeaders')?.value === true
    || fields.get(prefix + 'sendHeaders')?.classification === 'EXPRESSION')) return unknown('NO_REVIEWED_SINK_MODEL');
  return { status: 'SUPPORTED', sink: { sinkClass: model.sinkClass, parameter: model.parameter } };
}
