import type { IdentifierNode, StringNode, ValueNode } from '@humanwhocodes/momoa';
import type { SourceMemberRefV2, SourceParseResult, SourceValueV2 } from './source-types';

export function memberName(node: StringNode | IdentifierNode): string {
  return node.type === 'String' ? node.value : node.name;
}

export function sourceKind(node: ValueNode): SourceValueV2['kind'] {
  return node.type === 'Null' ? 'NULL' : node.type.toUpperCase() as SourceValueV2['kind'];
}

export function scalarValue(node: ValueNode): string | number | boolean | null {
  if (node.type === 'Null') return null;
  if (node.type === 'Number') {
    if (!Number.isFinite(node.value)) throw new TypeError('Non-finite JSON number');
    return node.value;
  }
  if (node.type === 'String' || node.type === 'Boolean') return node.value;
  throw new TypeError('Unexpected non-JSON scalar');
}

export function syntaxContribution(node: ValueNode): number {
  if (node.type === 'Object') return 1 + (node.members.length * 2);
  if (node.type === 'Array') return 1 + node.elements.length;
  return 1;
}

export function countDuplicates(names: readonly string[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const name of names) seen.has(name) ? count += 1 : seen.add(name);
  return count;
}

export function sliceNode(text: string, node: { range?: [number, number] }): string {
  if (!node.range) throw new TypeError('Source range missing');
  return text.slice(node.range[0], node.range[1]);
}

export function createUtf8OffsetMap(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    offsets[index] = bytes;
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    if (width === 2) offsets[index + 1] = bytes;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += width;
    offsets[index] = bytes;
  }
  return offsets;
}

export function sourceSpan(
  node: ValueNode,
  byteOffsets: Uint32Array,
): SourceMemberRefV2['span'] {
  if (!node.range) throw new TypeError('Source range missing');
  const [start, end] = node.range;
  return Object.freeze({
    start: Object.freeze({
      line: node.loc.start.line,
      column: node.loc.start.column,
      utf16Offset: start,
      utf8ByteOffset: byteOffsets[start],
    }),
    end: Object.freeze({
      line: node.loc.end.line,
      column: node.loc.end.column,
      utf16Offset: end,
      utf8ByteOffset: byteOffsets[end],
    }),
  });
}

export function complex(
  cause: 'SYNTAX_NODE_LIMIT' | 'DOCUMENT_DEPTH_LIMIT' | 'MEMBER_ELEMENT_LIMIT' | 'DUPLICATE_KEY_LIMIT' | 'SOURCE_WORK_LIMIT',
): SourceParseResult {
  return {
    ok: false,
    code: 'WORKFLOW_TOO_COMPLEX',
    cause,
    message: 'Workflow bytes exceed the configured source complexity limit.',
  };
}
