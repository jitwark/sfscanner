import { parse, type ArrayNode, type ObjectNode } from '@humanwhocodes/momoa';
import { escapeJsonPointerSegment } from './json-pointer';
import { compareCanonicalStrings } from './stable-order';
import { MAX_SOURCE_PARSER_DEPTH } from './source/source-preflight';

export type SourcePosition = { line: number; column: number; offset: number };

export type SourceSpan = { start: SourcePosition; end: SourcePosition };

export type DuplicateJsonKeyLocation = { pointer: string; key: string };

export type SourceMappedWorkflow = {
  value: unknown;
  nodeSpans: Array<SourceSpan | undefined>;
  duplicateKeys: DuplicateJsonKeyLocation[];
};

export class DuplicateKeyLocationLimitError extends Error {
  readonly code = 'DUPLICATE_KEY_LOCATION_LIMIT';

  constructor() {
    super('Duplicate-key source location output exceeds its configured limit.');
    this.name = 'DuplicateKeyLocationLimitError';
  }
}

/** Caps pointer construction work, including candidates later coalesced to an existing location. */
export const MAX_DUPLICATE_KEY_LOCATIONS = 16_384;
/** UTF-8 bytes across all candidate RFC 6901 pointers constructed for one document. */
export const MAX_DUPLICATE_KEY_POINTER_BYTES = 1_048_576;

export function parseWorkflowSource(workflowJson: string): SourceMappedWorkflow {
  const hasLeadingBom = workflowJson.charCodeAt(0) === 0xfeff;
  const source = hasLeadingBom ? workflowJson.slice(1) : workflowJson;
  const document = parse(source, { mode: 'json', ranges: true });
  const nodes = findNodesArray(document.body);

  return {
    // Keep momoa responsible for syntax and source metadata, but use the
    // platform JSON parser for values. momoa evaluates object members with
    // `object[key] = value`; a JSON key named `__proto__` would therefore
    // invoke Object.prototype's setter instead of becoming data.
    value: JSON.parse(source),
    nodeSpans: nodes?.elements.map((element) => toSourceSpan(element.value.loc, hasLeadingBom)) ?? [],
    duplicateKeys: findDuplicateJsonKeys(document.body),
  };
}

function findNodesArray(value: unknown): ArrayNode | undefined {
  if (!isObjectNode(value)) return undefined;
  const nodesMembers = value.members.filter((member) => memberName(member.name) === 'nodes');
  const lastMember = nodesMembers[nodesMembers.length - 1];
  return lastMember && isArrayNode(lastMember.value) ? lastMember.value : undefined;
}

const MAX_DUPLICATE_KEY_SCAN_DEPTH = MAX_SOURCE_PARSER_DEPTH;

type ContainerNode = ArrayNode | ObjectNode;
type PointerPath = { parent?: PointerPath; segment: string; pointerBytes: number };
type PendingNode = { node: ContainerNode; pointer?: PointerPath; depth: number };

function findDuplicateJsonKeys(root: unknown): DuplicateJsonKeyLocation[] {
  const results: DuplicateJsonKeyLocation[] = [];
  const reportedLocations = new Set<string>();
  const pending: PendingNode[] = isContainerNode(root)
    ? [{ node: root, depth: 0 }]
    : [];
  let duplicateLocationCount = 0;
  let duplicatePointerBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > MAX_DUPLICATE_KEY_SCAN_DEPTH) continue;

    if (isObjectNode(current.node)) {
      const seen = new Set<string>();
      const reportedDuplicates = new Set<string>();
      for (const member of current.node.members) {
        const key = memberName(member.name);
        if (key === undefined) continue;
        if (seen.has(key) && !reportedDuplicates.has(key)) {
          const pointerBytes = (current.pointer?.pointerBytes ?? 0) + pointerSegmentUtf8Bytes(key);
          if (
            duplicateLocationCount >= MAX_DUPLICATE_KEY_LOCATIONS
            || pointerBytes > MAX_DUPLICATE_KEY_POINTER_BYTES - duplicatePointerBytes
          ) {
            throw new DuplicateKeyLocationLimitError();
          }
          duplicateLocationCount += 1;
          duplicatePointerBytes += pointerBytes;
          const pointer = materializePointer(current.pointer, key);
          // The escaped final pointer segment is the key, so the pointer identifies this location.
          if (!reportedLocations.has(pointer)) {
            results.push({ pointer, key });
            reportedLocations.add(pointer);
          }
          reportedDuplicates.add(key);
        }
        seen.add(key);
        if (isContainerNode(member.value)) {
          pending.push({
            node: member.value,
            pointer: extendPointer(current.pointer, key),
            depth: current.depth + 1,
          });
        }
      }
    } else if (isArrayNode(current.node)) {
      current.node.elements.forEach((element, index) => {
        if (isContainerNode(element.value)) {
          pending.push({
            node: element.value,
            pointer: extendPointer(current.pointer, String(index)),
            depth: current.depth + 1,
          });
        }
      });
    }
  }

  return results.sort((a, b) => compareCanonicalStrings(a.pointer, b.pointer));
}

function materializePointer(parent: PointerPath | undefined, segment: string): string {
  const segments = [escapeJsonPointerSegment(segment)];
  for (let current = parent; current; current = current.parent) {
    segments.push(escapeJsonPointerSegment(current.segment));
  }
  return `/${segments.reverse().join('/')}`;
}

function extendPointer(parent: PointerPath | undefined, segment: string): PointerPath {
  return {
    parent,
    segment,
    pointerBytes: (parent?.pointerBytes ?? 0) + pointerSegmentUtf8Bytes(segment),
  };
}

/** Counts the slash and RFC 6901 escaped segment without building a pointer string. */
function pointerSegmentUtf8Bytes(segment: string): number {
  let bytes = 1;
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code === 0x2f || code === 0x7e) {
      bytes += 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < segment.length) {
      const next = segment.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      // Includes lone surrogates, which TextEncoder represents as U+FFFD.
      bytes += 3;
    }
  }
  return bytes;
}

function isContainerNode(value: unknown): value is ContainerNode {
  return isObjectNode(value) || isArrayNode(value);
}

function isObjectNode(value: unknown): value is ObjectNode {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'Object';
}

function isArrayNode(value: unknown): value is ArrayNode {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'Array';
}

function memberName(value: { type: string; value?: string; name?: string }): string | undefined {
  return value.type === 'String' ? value.value : value.name;
}

function toSourceSpan(
  location: { start: SourcePosition; end: SourcePosition },
  hasLeadingBom: boolean,
): SourceSpan {
  const originalPosition = (position: SourcePosition): SourcePosition => hasLeadingBom
    ? { ...position, column: position.column + (position.line === 1 ? 1 : 0), offset: position.offset + 1 }
    : { ...position };
  return { start: originalPosition(location.start), end: originalPosition(location.end) };
}
