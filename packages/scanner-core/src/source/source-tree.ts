import type { ValueNode } from '@humanwhocodes/momoa';
import type { ScannerLimitsV2 } from '@hub/contracts';
import { escapeJsonPointerSegment } from '../json-pointer';
import {
  createSourceAstNodeId,
  createSourceMemberRef,
  encodeSourceSlot,
  encodeSourceTuple,
  type SourceSlot,
} from './source-identities';
import {
  complex,
  countDuplicates,
  createUtf8OffsetMap,
  memberName,
  scalarValue,
  sliceNode,
  sourceKind,
  sourceSpan,
  syntaxContribution,
} from './source-tree-helpers';
import type {
  SourceMemberRefV2,
  SourceParseResult,
  SourceSpanUsageV2,
  SourceValueV2,
} from './source-types';

export type NodeContext = {
  node: ValueNode;
  pointer: string;
  occurrencePath: readonly number[];
  slot: SourceSlot;
  depth: number;
};

export type SourceAnalysis = {
  contexts: NodeContext[];
  duplicateCount: number;
  syntaxNodeCount: number;
  sourceWorkUnits: number;
};

type NodeIdentity = { astNodeId: string; payload: string };

export function analyzeSource(
  root: ValueNode,
  text: string,
  limits: ScannerLimitsV2,
): SourceAnalysis | SourceParseResult {
  const contexts: NodeContext[] = [];
  const pending: NodeContext[] = [{
    node: root, pointer: '', occurrencePath: [], slot: { kind: 'ROOT' }, depth: 1,
  }];
  let duplicateCount = 0;
  let syntaxNodeCount = 1;
  let membersAndElements = 0;
  let sourceWorkUnits = 0;

  while (pending.length > 0) {
    const context = pending.pop()!;
    if (context.depth > limits.maxDocumentDepth) return complex('DOCUMENT_DEPTH_LIMIT');
    contexts.push(context);
    syntaxNodeCount += syntaxContribution(context.node);
    if (syntaxNodeCount > limits.maxSyntaxNodes) return complex('SYNTAX_NODE_LIMIT');

    const childCount = directChildCount(context.node);
    membersAndElements += childCount;
    if (membersAndElements > limits.maxMembersAndElements) return complex('MEMBER_ELEMENT_LIMIT');
    if (context.node.type === 'Object') {
      duplicateCount += countDuplicates(context.node.members.map((member) => memberName(member.name)));
      if (duplicateCount > limits.maxDuplicateKeys) return complex('DUPLICATE_KEY_LIMIT');
    }
    if (contexts.length === 1) {
      if (context.depth > limits.maxSourceWork) return complex('SOURCE_WORK_LIMIT');
      sourceWorkUnits += context.depth;
    }
    const childDepth = context.depth + 1;
    const childWorkUnits = childCount * childDepth;
    if (sourceWorkUnits > limits.maxSourceWork - childWorkUnits) return complex('SOURCE_WORK_LIMIT');
    sourceWorkUnits += childWorkUnits;
    const children = childContexts(context, text);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return { contexts, duplicateCount, syntaxNodeCount, sourceWorkUnits };
}

function directChildCount(node: ValueNode): number {
  if (node.type === 'Array') return node.elements.length;
  if (node.type === 'Object') return node.members.length;
  return 0;
}

export function buildSourceTree(
  contexts: NodeContext[],
  text: string,
  spanLimit: number,
): Readonly<{ value: SourceValueV2; usage: SourceSpanUsageV2 }> {
  const identities = new WeakMap<ValueNode, NodeIdentity>();
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const context = contexts[index];
    const payload = sourcePayload(context.node, text, identities);
    const astNodeId = createSourceAstNodeId({
      occurrencePath: context.occurrencePath,
      slot: encodeSourceSlot(context.slot),
      kind: sourceKind(context.node),
      payload,
    });
    identities.set(context.node, { astNodeId, payload });
  }
  const retained = new Set(contexts.slice(0, spanLimit).map((context) => context.node));
  const values = new WeakMap<ValueNode, SourceValueV2>();
  const byteOffsets = createUtf8OffsetMap(text);
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const context = contexts[index];
    const identity = identities.get(context.node)!;
    const ref = createSourceMemberRef({
      pointer: context.pointer,
      occurrencePath: context.occurrencePath,
      slot: context.slot,
      kind: sourceKind(context.node),
      payload: identity.payload,
      astNodeId: identity.astNodeId,
      reuseOccurrencePath: true,
      span: retained.has(context.node) ? sourceSpan(context.node, byteOffsets) : null,
    });
    values.set(context.node, materializeValue(context.node, text, ref, values));
  }
  return Object.freeze({
    value: values.get(contexts[0].node)!,
    usage: Object.freeze({ examined: contexts.length, omitted: contexts.length - retained.size }),
  });
}

function childContexts(parent: NodeContext, text: string): NodeContext[] {
  if (parent.node.type === 'Array') return parent.node.elements.map((element, index) => ({
    node: element.value,
    pointer: `${parent.pointer}/${index}`,
    occurrencePath: [...parent.occurrencePath, index],
    slot: { kind: 'ARRAY', index },
    depth: parent.depth + 1,
  }));
  if (parent.node.type !== 'Object') return [];
  const seen = new Map<string, number>();
  return parent.node.members.map((member, index) => {
    const name = memberName(member.name);
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return {
      node: member.value,
      pointer: `${parent.pointer}/${escapeJsonPointerSegment(name)}`,
      occurrencePath: [...parent.occurrencePath, index],
      slot: { kind: 'MEMBER', nameLexeme: sliceNode(text, member.name), occurrence },
      depth: parent.depth + 1,
    };
  });
}

function materializeValue(
  node: ValueNode,
  text: string,
  ref: SourceMemberRefV2,
  values: WeakMap<ValueNode, SourceValueV2>,
): SourceValueV2 {
  if (node.type === 'Array') return Object.freeze({
    kind: 'ARRAY',
    ref,
    items: Object.freeze(node.elements.map((element) => values.get(element.value)!)),
  });
  if (node.type === 'Object') {
    const seen = new Map<string, number>();
    const members = node.members.map((member) => {
      const name = memberName(member.name);
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      const value = values.get(member.value)!;
      return Object.freeze({
        nameLexeme: sliceNode(text, member.name),
        name,
        occurrence,
        ref: value.ref,
        value,
      });
    });
    return Object.freeze({ kind: 'OBJECT', ref, members: Object.freeze(members) });
  }
  return Object.freeze({
    kind: sourceKind(node),
    lexeme: sliceNode(text, node),
    value: scalarValue(node),
    ref,
  }) as SourceValueV2;
}

function sourcePayload(node: ValueNode, text: string, identities: WeakMap<ValueNode, NodeIdentity>): string {
  if (node.type === 'Array') {
    return encodeSourceTuple(node.elements.map((element) => identities.get(element.value)!.astNodeId));
  }
  if (node.type === 'Object') {
    return encodeSourceTuple(node.members.map((member) => identities.get(member.value)!.astNodeId));
  }
  return sliceNode(text, node);
}
