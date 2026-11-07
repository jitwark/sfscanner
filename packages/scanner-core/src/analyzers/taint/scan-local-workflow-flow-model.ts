import type { EdgeRefV2, SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import type { SemanticCatalogueViewV2, SubjectV2 } from '../../capabilities/scheduler';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { expressionIslands } from '../expression/expression-islands';
import { resolveStaticReference } from '../expression/static-references';
import type { ScanLocalFlowSinkSpecV1 } from './scan-local-flow-witness-facts';
import type { ScanLocalWitnessInputV1 } from './scan-local-traces';
import { knownState, type FieldStateV1, type ScanLocalChargeV1 } from './scan-local-state';
import type { FieldTransferModelV1 } from './scan-local-transfer';
import type { TaintLabel } from './taint-lattice';
import { taintSourceLabelsFor } from './taint-sources';
import { TAINT_SINK_CATALOG } from './taint-sink-catalog';
import { isCataloguedFlowSinkV1, selectReviewedFlowSinkV1 } from './scan-local-flow-sink-selection';

export type WorkflowFlowModelUnknownReasonV1 =
  | 'NO_REVIEWED_PAIR' | 'UNSUPPORTED_VERSION' | 'AMBIGUOUS_IR'
  | 'MISSING_SPAN' | 'UNSUPPORTED_EDGE' | 'UNSUPPORTED_PORT'
  | 'DYNAMIC_FIELD' | 'UNSUPPORTED_EXPRESSION' | 'DISCONNECTED' | 'NO_REVIEWED_SINK_MODEL';

export type WorkflowFlowWitnessPlanV1 = Readonly<{
  carriers: NonNullable<ScanLocalWitnessInputV1['carriers']>;
  sources: NonNullable<ScanLocalWitnessInputV1['sources']>;
  edges: NonNullable<ScanLocalWitnessInputV1['edges']>;
  requests: NonNullable<ScanLocalWitnessInputV1['requests']>;
  subjects: NonNullable<ScanLocalWitnessInputV1['subjects']>;
}>;

type WitnessCarrierV1 = NonNullable<ScanLocalWitnessInputV1['carriers']> extends ReadonlyMap<string, infer Carrier>
  ? Carrier : never;

export type WorkflowFlowModelResultV1 =
  | Readonly<{ status: 'SUPPORTED'; entry: string; initialState: FieldStateV1;
      transferModels: ReadonlyMap<string, FieldTransferModelV1>;
      graph: ReadonlyMap<string, readonly string[]>;
      witness: WorkflowFlowWitnessPlanV1; sinks: ReadonlyMap<string, ScanLocalFlowSinkSpecV1>;
      taintLabels: readonly TaintLabel[] }>
  | Readonly<{ status: 'UNKNOWN'; reason: WorkflowFlowModelUnknownReasonV1 }>
  | Readonly<{ status: 'NOT_APPLICABLE' }>
  | Readonly<{ status: 'LIMITED'; omittedLowerBound: number }>;

const WEBHOOK = 'n8n-nodes-base.webhook';
const EXECUTE_COMMAND = 'n8n-nodes-base.executeCommand';
const unknown = (reason: WorkflowFlowModelUnknownReasonV1): WorkflowFlowModelResultV1 =>
  Object.freeze({ status: 'UNKNOWN', reason });
const notApplicable = (): WorkflowFlowModelResultV1 => Object.freeze({ status: 'NOT_APPLICABLE' });
const limited = (): WorkflowFlowModelResultV1 => Object.freeze({ status: 'LIMITED', omittedLowerBound: 1 });

function validDensePath(path: readonly number[]): boolean {
  if (path.length === 0) return false;
  for (let index = 0; index < path.length; index += 1) {
    if (!Object.hasOwn(path, index) || !Number.isSafeInteger(path[index]) || path[index]! < 0) return false;
  }
  return true;
}

function validNodeSpan(node: SecurityNodeV2): boolean {
  return node.ref.source.span !== null && node.ref.source.pointer === `/nodes/${node.ref.ordinal}`
    && validDensePath(node.ref.source.occurrencePath);
}

function validEdgeSpan(edge: EdgeRefV2): boolean {
  const ptrEscape = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
  const expected = `/connections/${ptrEscape(edge.sourceLabel)}/${ptrEscape(edge.connectionType)}/`
    + `${String(edge.sourcePort)}/0`;
  const pointerSegments = edge.source.pointer.split('/');
  return pointerSegments.length === 6 && pointerSegments.slice(1).every((segment) => segment.length > 0)
    && edge.source.pointer === expected && edge.source.span !== null
    && edge.source.occurrencePath.length === 5 && validDensePath(edge.source.occurrencePath);
}

function hasSourceSemantics(semantics: ResolvedNodeSemanticsV2): boolean {
  return semantics.semanticId === 'ingress.webhook'
    && semantics.provenance.sourceDigest === '3bc990dc63c7b59292d3c13553925ef81e6e9df6ee35550d6fa850a536567a13'
    && semantics.entry === 'TRIGGER' && semantics.endpoints.filter((endpoint) =>
    endpoint.path === '/body' && endpoint.channel === 'DATA' && endpoint.direction === 'SOURCE'
    && endpoint.taint !== 'INTEGRITY').length === 1
    && semantics.ports.length === 1 && semantics.ports[0]?.type === 'main'
    && semantics.ports[0].index === 0 && semantics.ports[0].itemMode === 'EACH';
}

function hasSinkSemantics(semantics: ResolvedNodeSemanticsV2): boolean {
  return semantics.semanticId === 'code-command.execute-command'
    && semantics.provenance.sourceDigest === 'b636dc56cc56160789616433e10e65338b91e448a1c8172cd1206cedca09924e'
    && semantics.effects.includes('EXECUTE_COMMAND')
    && semantics.parameterPaths.filter((path) => path.pointer === '/command').length === 1
    && semantics.ports.length === 1 && semantics.ports[0]?.type === 'main'
    && semantics.ports[0].index === 0 && semantics.ports[0].itemMode === 'EACH';
}

export function compileScanLocalWorkflowFlowModelV1(input: Readonly<{
  workflow: SecurityWorkflowV2; semantics: SemanticCatalogueViewV2; charge: ScanLocalChargeV1;
}>): WorkflowFlowModelResultV1 {
  let refused = false;
  const read = (units: number): boolean => {
    if (refused) return false;
    if (!input.charge(units)) { refused = true; return false; }
    return true;
  };
  if (!read(1)) return limited();
  const catalogUnits = TAINT_SINK_CATALOG.reduce((sum, entry) => sum + entry.nodeTypes.length, 0);
  if (!read(input.workflow.nodes.length * (2 + catalogUnits))) return limited();
  const pairPresent = input.workflow.nodes.some((node) => node.type === WEBHOOK)
    && input.workflow.nodes.some((node) => isCataloguedFlowSinkV1(node.type));
  if (input.workflow.nodes.length !== 2) return pairPresent ? unknown('NO_REVIEWED_PAIR') : notApplicable();
  if (!read(1)) return limited();
  if (input.workflow.ambiguities.length > 0) return pairPresent ? unknown('AMBIGUOUS_IR') : notApplicable();
  const found: SecurityNodeV2[] = [];
  for (const node of input.workflow.nodes) {
    if (!read(4)) return limited();
    if (node.type === WEBHOOK || isCataloguedFlowSinkV1(node.type)) found.push(node);
  }
  const sources = found.filter((node) => node.type === WEBHOOK);
  const sinks = found.filter((node) => isCataloguedFlowSinkV1(node.type));
  if (sources.length > 1 || sinks.length > 1) return pairPresent ? unknown('AMBIGUOUS_IR') : notApplicable();
  const source = sources[0]; const sink = sinks[0];
  if (!source || !sink) return notApplicable();
  if (source.typeVersion !== '1.0.0') return unknown('UNSUPPORTED_VERSION');
  if (source.disabled || sink.disabled || source.scoringEligibility !== 'ELIGIBLE'
    || sink.scoringEligibility !== 'ELIGIBLE') return unknown('AMBIGUOUS_IR');
  if (!validNodeSpan(source) || !validNodeSpan(sink)) return unknown('MISSING_SPAN');
  if (input.workflow.edges.length === 0) return unknown('DISCONNECTED');
  if (input.workflow.edges.length > 1) return unknown('AMBIGUOUS_IR');
  const edge = input.workflow.edges[0]!;
  if (!read(5)) return limited();
  if (edge.resolution !== 'RESOLVED' || edge.connectionType !== 'main') return unknown('UNSUPPORTED_EDGE');
  if (!edge.sourceNode || !edge.targetNode || edge.sourceNode.ordinal !== source.ref.ordinal
    || edge.targetNode.ordinal !== sink.ref.ordinal || edge.sourceNode.identityDigest !== source.ref.identityDigest
    || edge.targetNode.identityDigest !== sink.ref.identityDigest) return unknown('DISCONNECTED');
  if (edge.sourcePort !== 0 || edge.targetPort !== 0) return unknown('UNSUPPORTED_PORT');
  if (!validEdgeSpan(edge)) return unknown('MISSING_SPAN');
  if (!read(2)) return limited();
  const sourceSemantics = input.semantics.resolvedNodeSemantics.get(source.ref.identityDigest);
  const sinkSemantics = input.semantics.resolvedNodeSemantics.get(sink.ref.identityDigest);
  const selected = selectReviewedFlowSinkV1(sink, sinkSemantics, read);
  if (selected.status !== 'SUPPORTED') return selected;
  const { sinkClass, parameter } = selected.sink;
  if (!sourceSemantics || !sinkSemantics || sourceSemantics.nodeType !== WEBHOOK
    || sinkSemantics.nodeType !== sink.type) return unknown('NO_REVIEWED_PAIR');
  if (!read(4 + sourceSemantics.endpoints.length + sourceSemantics.ports.length
    + sinkSemantics.effects.length + sinkSemantics.parameterPaths.length + sinkSemantics.ports.length)) return limited();
  if (!hasSourceSemantics(sourceSemantics) || (sinkClass === 'COMMAND' && !hasSinkSemantics(sinkSemantics))) return unknown('NO_REVIEWED_PAIR');
  if (!read(1 + TAINT_SINK_CATALOG.length)) return limited();
  if (!TAINT_SINK_CATALOG.some((entry) => entry.nodeTypes.includes(sink.type)
    && entry.parameterPaths.includes(parameter) && entry.sink === sinkClass)) return unknown('NO_REVIEWED_PAIR');
  if (!read(1)) return limited();
  const taintLabels = taintSourceLabelsFor(WEBHOOK);
  if (!taintLabels?.includes('WEBHOOK_BODY')) return unknown('NO_REVIEWED_PAIR');

  if (!read(1 + source.parameters.length)) return limited();
  const methods = source.parameters.filter((field) => field.pointer === `/nodes/${source.ref.ordinal}/parameters/httpMethod`);
  if (methods.length === 0) return unknown('NO_REVIEWED_PAIR');
  if (methods.length !== 1) return unknown('AMBIGUOUS_IR');
  const method = methods[0]!;
  if (typeof method.value !== 'string' || method.value.length === 0 || method.classification !== 'PLAIN') {
    return unknown('DYNAMIC_FIELD');
  }

  if (!read(1 + sink.parameters.length)) return limited();
  const commands = sink.parameters.filter((field) => field.pointer === `/nodes/${sink.ref.ordinal}/parameters/${parameter}`);
  if (commands.length === 0) return unknown('NO_REVIEWED_PAIR');
  if (commands.length !== 1) return unknown('AMBIGUOUS_IR');
  const command = commands[0]!;
  if (typeof command.value !== 'string') return unknown('NO_REVIEWED_PAIR');
  if (command.classification !== 'EXPRESSION') {
    return unknown(command.value.includes('{{') ? 'UNSUPPORTED_EXPRESSION' : 'NO_REVIEWED_PAIR');
  }
  if (!read(1 + command.occurrences.length)) return limited();
  const occurrence = command.occurrences.length === 1 ? command.occurrences[0] : undefined;
  if (!occurrence || occurrence.span === null || occurrence.pointer !== command.pointer
    || !validDensePath(occurrence.occurrencePath)) return unknown('MISSING_SPAN');
  if (!read(1 + command.value.length)) return limited();
  if (!command.value.startsWith('=')) return unknown('UNSUPPORTED_EXPRESSION');
  const text = command.value.slice(1);
  const islands = expressionIslands(text, text.length);
  if (islands.status !== 'COMPLETE' || islands.islands.length !== 1) return unknown('UNSUPPORTED_EXPRESSION');
  const island = islands.islands[0]!;
  if (island.startUtf16 !== 0 || island.endUtf16 !== text.length) return unknown('UNSUPPORTED_EXPRESSION');
  const expression = text.slice(island.bodyStartUtf16, island.bodyEndUtf16);
  if (!read(1 + expression.length)) return limited();
  const reference = resolveStaticReference(expression, expression.length);
  if (reference.reason === 'DYNAMIC_PATH' || reference.reason === 'DYNAMIC_LABEL') return unknown('DYNAMIC_FIELD');
  if (reference.status !== 'EXACT' || reference.kind !== 'CURRENT_INPUT' || reference.item !== 'CURRENT'
    || reference.path.length !== 2 || reference.path[0] !== 'body' || (sinkClass === 'COMMAND' ? reference.path[1] !== 'cmd' : !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(reference.path[1]!))) {
    return unknown('UNSUPPORTED_EXPRESSION');
  }

  const sourceKey = source.ref.identityDigest; const sinkKey = sink.ref.identityDigest;
  const atom = Object.freeze({ sourceId: sourceKey, field: Object.freeze([...reference.path]), channel: 'CONFIDENTIALITY' as const });
  const sourceCarrier = Object.freeze({ kind: 'SOURCE' as const, node: source.ref.ordinal, field: reference.path.join('.'), port: 0, item: 0 });
  const sinkCarrier = Object.freeze({ kind: 'SINK' as const, node: sink.ref.ordinal, field: `/${parameter}`, port: 0, item: 0 });
  const carriers = new Map<string, WitnessCarrierV1>([[sourceKey, sourceCarrier], [sinkKey, sinkCarrier]]);
  const subjects = new Map<number, SubjectV2>([[source.ref.ordinal, Object.freeze({ kind: 'NODE' as const, node: source.ref })],
    [sink.ref.ordinal, Object.freeze({ kind: 'NODE' as const, node: sink.ref })]]);
  const sinksMap = new Map([[sinkKey, Object.freeze({ sinkClass, sinkParameterPath: `/${parameter}`,
    sinkFieldPath: Object.freeze([parameter]), sinkChannel: 'DATA', edgeChannel: 'DATA' })]]);
  const graph = new Map([[sourceKey, Object.freeze([sinkKey])], [sinkKey, Object.freeze([] as string[])]]);
  const edges = new Map([[sourceKey, new Map([[sinkKey, Object.freeze({ ordinal: edge.ordinal, channel: 'DATA' as const, supported: true })]] )]]);
  const requests = Object.freeze([Object.freeze({ atom, sink: sinkKey, channel: 'DATA' as const,
    terminalInputRead: Object.freeze({ channel: 'DATA' as const, path: atom.field,
      sinkParameterPath: `/${parameter}`, carrier: sinkCarrier }) })]);
  const witness = Object.freeze({ carriers, sources: new Map([[sourceKey, sourceKey]]), edges, requests, subjects });
  return Object.freeze({ status: 'SUPPORTED', entry: sourceKey, initialState: knownState([atom]),
    transferModels: new Map([[sourceKey, { kind: 'COPY' as const }], [sinkKey, { kind: 'COPY' as const }]]),
    graph, witness, sinks: sinksMap, taintLabels: Object.freeze(taintLabels.filter((label) => label === 'WEBHOOK_BODY')) });
}
