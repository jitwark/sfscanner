import type { NodeCategory } from './graph-layout';

export const SVG_PREVIEW_SCHEMA_VERSION = 'svg-preview-v1' as const;
export type SvgPreviewTier = 'A' | 'B' | 'C' | 'invalid';

export type SvgPreviewListItem = {
  id: string;
  name: string;
  type: string;
  category: NodeCategory;
};

/** The subset written to and consumed from a public preview artifact. */
export type SvgPreviewArtifact = {
  schemaVersion: typeof SVG_PREVIEW_SCHEMA_VERSION;
  tier: SvgPreviewTier;
  svg: string;
  nodeList: SvgPreviewListItem[];
  contentHash: string;
  unresolvedEdgeCount: number;
};

/** Build-time metrics kept out of the public line to keep its contract small. */
export type SvgPreview = SvgPreviewArtifact & {
  width: number;
  height: number;
  elementCount: number;
  truncatedLabelCount: number;
};

const CATEGORIES: ReadonlySet<NodeCategory> = new Set([
  'trigger', 'transform', 'ai', 'http', 'code', 'storage', 'flow', 'other',
]);
const CATEGORY_BY_CODE: readonly NodeCategory[] = ['trigger', 'transform', 'ai', 'http', 'code', 'storage', 'flow', 'other'];
const HASH = /^[0-9a-f]{64}$/;
const MAX_PREVIEW_NODES = 5_000;
const MAX_PREVIEW_SVG_CHARS = 512_000;
const MAX_NODE_TEXT_CHARS = 1_024;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const COLORS = new Set(['#0f172a', '#64748b', '#cbd5e1', '#22c55e', '#a855f7', '#3b82f6', '#f59e0b', '#06b6d4', '#ec4899', '#94a3b8']);
const ATTRIBUTES: Record<string, readonly string[]> = {
  svg: ['xmlns', 'viewBox', 'preserveAspectRatio', 'role'],
  g: ['id'],
  title: [],
  path: ['id', 'd', 'fill', 'stroke', 'stroke-width'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'fill', 'fill-opacity', 'stroke', 'stroke-width'],
  text: ['x', 'y', 'text-anchor', 'dominant-baseline', 'font-size', 'fill'],
};

function attributesOf(raw: string): Record<string, string> | null {
  const result = Object.create(null) as Record<string, string>;
  let index = 0;
  while (index < raw.length) {
    while (/\s/.test(raw[index] ?? '')) index += 1;
    if (index === raw.length) break;
    const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(raw.slice(index))?.[0];
    if (!name || Object.hasOwn(result, name)) return null;
    index += name.length;
    while (/\s/.test(raw[index] ?? '')) index += 1;
    if (raw[index] !== '=') return null;
    index += 1;
    while (/\s/.test(raw[index] ?? '')) index += 1;
    if (raw[index] !== '"') return null;
    index += 1;
    const end = raw.indexOf('"', index);
    if (end < 0) return null;
    const value = raw.slice(index, end);
    if (value.includes('<')) return null;
    result[name] = value;
    index = end + 1;
  }
  return result;
}

function safeAttributes(tag: string, attrs: Record<string, string>): boolean {
  const allowed = ATTRIBUTES[tag];
  if (!allowed || Object.keys(attrs).some((name) => !allowed.includes(name))) return false;
  const has = (...names: string[]) => names.every((name) => Object.hasOwn(attrs, name));
  const isNumber = (name: string, positive = false) => NUMBER.test(attrs[name] ?? '') && (!positive || Number(attrs[name]) > 0);
  const isColor = (name: string) => COLORS.has(attrs[name] ?? '');
  if (tag === 'svg') return attrs.xmlns === 'http://www.w3.org/2000/svg'
    && /^0 0 [1-9]\d* [1-9]\d*$/.test(attrs.viewBox ?? '')
    && (attrs.preserveAspectRatio === undefined || attrs.preserveAspectRatio === 'xMidYMid meet')
    && (attrs.role === undefined || attrs.role === 'img');
  if (tag === 'g') return /^([nc]-\d+)$/.test(attrs.id ?? '');
  if (tag === 'title') return Object.keys(attrs).length === 0;
  if (tag === 'path') return has('id', 'd', 'fill', 'stroke', 'stroke-width')
    && /^e-\d+$/.test(attrs.id ?? '')
    && /^M[\sMmLlHhVvCcSsQqTtAaZz0-9eE+.,-]+$/.test(attrs.d ?? '')
    && (attrs.fill === 'none' || isColor('fill')) && isColor('stroke') && isNumber('stroke-width', true);
  if (tag === 'rect') return has('x', 'y', 'width', 'height', 'fill', 'stroke')
    && isNumber('x') && isNumber('y') && isNumber('width', true) && isNumber('height', true)
    && (attrs.rx === undefined || (isNumber('rx') && Number(attrs.rx) >= 0))
    && (attrs.fill === 'none' || isColor('fill')) && isColor('stroke')
    && (attrs['fill-opacity'] === undefined || (isNumber('fill-opacity') && Number(attrs['fill-opacity']) >= 0 && Number(attrs['fill-opacity']) <= 1))
    && (attrs['stroke-width'] === undefined || isNumber('stroke-width', true));
  if (tag === 'text' && Object.keys(attrs).length === 0) return true;
  return tag === 'text' && has('x', 'y', 'text-anchor', 'font-size', 'fill')
    && ['x', 'y'].every((name) => isNumber(name) || /^\d+(?:\.\d+)?%$/.test(attrs[name] ?? ''))
    && attrs['text-anchor'] === 'middle' && isNumber('font-size', true) && isColor('fill')
    && (attrs['dominant-baseline'] === undefined || attrs['dominant-baseline'] === 'middle');
}

/** Accept only static markup emitted by the preview renderer; reject comments and active SVG/CSS constructs. */
function isSafePreviewSvg(svg: string): boolean {
  const parents: Record<string, readonly string[]> = {
    svg: [''], title: ['svg', 'g'], g: ['svg'], path: ['svg'], rect: ['g'], text: ['svg', 'g'],
  };
  const stack: string[] = [];
  let index = 0;
  let rootSeen = false;
  let rootClosed = false;
  while (index < svg.length) {
    if (svg[index] !== '<') {
      const end = svg.indexOf('<', index);
      const text = svg.slice(index, end < 0 ? svg.length : end);
      if (text.length > 0 && (!['title', 'text'].includes(stack.at(-1) ?? '') || rootClosed)) return false;
      index = end < 0 ? svg.length : end;
      continue;
    }
    const end = svg.indexOf('>', index + 1);
    if (end < 0) return false;
    const token = svg.slice(index, end + 1);
    if (token.includes('<', 1)) return false;
    if (token.startsWith('</')) {
      const name = /^<\/([a-z]+)>$/.exec(token)?.[1];
      if (!name || stack.pop() !== name) return false;
      if (name === 'svg') rootClosed = true;
    } else {
      const selfClosing = token.endsWith('/>');
      const parsed = /^<([a-z]+)([\s\S]*)>$/.exec(token);
      const name = parsed?.[1];
      if (!name || (selfClosing && name !== 'path' && name !== 'rect')) return false;
      const rawAttrs = parsed?.[2]?.slice(0, selfClosing ? -1 : undefined) ?? '';
      const attrs = attributesOf(rawAttrs);
      const parent = stack.at(-1) ?? '';
      if (!attrs || !parents[name] || !parents[name]!.includes(parent) || !safeAttributes(name, attrs)) return false;
      if (name === 'svg') {
        if (rootSeen || rootClosed || selfClosing) return false;
        rootSeen = true;
      } else if (!rootSeen || rootClosed) return false;
      if (!selfClosing) stack.push(name);
    }
    index = end + 1;
  }
  return rootSeen && rootClosed && stack.length === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function previewNodeRecord(value: unknown, typeTable: string[] | null, fallbackId: string): Record<string, unknown> | null {
  if (Array.isArray(value) && (value.length === 3 || value.length === 4)) {
    const id = value.length === 4 ? value[0] : fallbackId;
    const typeValue = value.length === 4 ? value[2] : value[1];
    const categoryValue = value.length === 4 ? value[3] : value[2];
    const type = typeof typeValue === 'number' && typeTable ? typeTable[typeValue] : typeValue;
    const category = typeof categoryValue === 'number' ? CATEGORY_BY_CODE[categoryValue] : categoryValue;
    return { id, name: value.length === 4 ? value[1] : value[0], type, category };
  }
  return record(value);
}

/**
 * Validates untrusted JSON before its SVG string reaches innerHTML. Hash
 * verification belongs to the transport loader because it is asynchronous;
 * this parser owns schema, size, and construct validation.
 */
export function parseSvgPreviewArtifact(value: unknown): SvgPreviewArtifact | null {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== SVG_PREVIEW_SCHEMA_VERSION) return null;
  if (candidate.tier !== 'A' && candidate.tier !== 'B' && candidate.tier !== 'C' && candidate.tier !== 'invalid') return null;
  if (typeof candidate.svg !== 'string' || candidate.svg.length === 0 || candidate.svg.length > MAX_PREVIEW_SVG_CHARS) return null;
  if (!isSafePreviewSvg(candidate.svg)) return null;
  if (typeof candidate.contentHash !== 'string' || !HASH.test(candidate.contentHash)) return null;
  if (!Number.isInteger(candidate.unresolvedEdgeCount) || (candidate.unresolvedEdgeCount as number) < 0) return null;

  if (!Array.isArray(candidate.nodeList) || candidate.nodeList.length > MAX_PREVIEW_NODES) return null;
  const typeTable = candidate.nodeTypes === undefined ? null
    : Array.isArray(candidate.nodeTypes) && candidate.nodeTypes.every((type) => typeof type === 'string' && type.length <= MAX_NODE_TEXT_CHARS)
      ? candidate.nodeTypes as string[] : null;
  if (candidate.nodeTypes !== undefined && typeTable === null) return null;
  const nodeList: SvgPreviewListItem[] = [];
  for (const [index, rawNode] of candidate.nodeList.entries()) {
    const node = previewNodeRecord(rawNode, typeTable, `node-${index}`);
    if (
      !node ||
      typeof node.id !== 'string' || node.id.length === 0 || node.id.length > MAX_NODE_TEXT_CHARS ||
      typeof node.name !== 'string' || node.name.length > MAX_NODE_TEXT_CHARS ||
      typeof node.type !== 'string' || node.type.length > MAX_NODE_TEXT_CHARS ||
      typeof node.category !== 'string' || !CATEGORIES.has(node.category as NodeCategory)
    ) return null;
    nodeList.push({ id: node.id, name: node.name, type: node.type, category: node.category as NodeCategory });
  }

  return {
    schemaVersion: SVG_PREVIEW_SCHEMA_VERSION,
    tier: candidate.tier as SvgPreviewTier,
    svg: candidate.svg,
    nodeList,
    contentHash: candidate.contentHash,
    unresolvedEdgeCount: candidate.unresolvedEdgeCount as number,
  };
}
