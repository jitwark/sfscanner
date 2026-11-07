import { parseExpression } from '../taint/expression-parser';
import { isAstNode, resolveStaticName, type AstNode } from '../taint/taint-expression-references';

export type ItemSelector = 'CURRENT' | 'FIRST' | 'LAST' | 'ALL';
export type LabelIndex = ReadonlyMap<string, number>;
export type StaticReference = Readonly<{
  nodeLabel: string | null;
  path: readonly string[];
  item: ItemSelector;
  kind: 'NODE' | 'CURRENT_INPUT';
  status: 'EXACT' | 'BROAD' | 'UNKNOWN';
  reason: string | null;
}>;

const SELECTORS: Readonly<Record<string, ItemSelector>> = Object.freeze({
  first: 'FIRST', last: 'LAST', all: 'ALL', item: 'CURRENT',
});
const CURRENT_ROOTS = new Set(['$json', '$input']);

const MAX_PATH_SEGMENTS = 256;
const unknown = (reason: string, nodeLabel: string | null = null, kind: 'NODE' | 'CURRENT_INPUT' = nodeLabel === null ? 'CURRENT_INPUT' : 'NODE'): StaticReference => Object.freeze({
  nodeLabel, path: Object.freeze([]), item: 'CURRENT', kind, status: 'UNKNOWN', reason,
});

export function resolveStaticReference(expression: string, maxWork: number, labels?: LabelIndex): StaticReference {
  if (!Number.isSafeInteger(maxWork) || maxWork < 0) throw new TypeError('maxWork must be a non-negative safe integer');
  if (expression.length > maxWork) return unknown('WORK_LIMIT');
  if (expression.trim().length === 0) return unknown('EMPTY');
  let program;
  try { program = parseExpression(expression); } catch (error) { return error instanceof RangeError ? unknown('PARSE_LIMIT') : unknown('PARSE_ERROR'); }
  if (program === undefined) return unknown('PARSE_ERROR');
  let node: unknown = program;
  let item: ItemSelector = 'CURRENT';
  let selectorSeen = false;
  let steps = 0;
  const path: string[] = [];
  for (;;) {
    steps += 1;
    if (steps > maxWork) return unknown('WORK_LIMIT');
    if (!isAstNode(node)) return unknown('UNSUPPORTED_CHAIN');
    if (node.type === 'MemberExpression') {
      const object = node.object;
      const property = staticMember(node);
      if (property === undefined) return unknown('DYNAMIC_PATH');
      if (isIdentifier(object, '$node')) {
        return finish(nodeLabelOf(property), path, item, labels);
      }
      if (property === 'item' && isIdentifier(object, '$input')) { item = 'CURRENT'; node = object; continue; }
      if (property === 'item' && isSelectorCall(object)) return unknown('CHAINED_SELECTOR', null, 'NODE');
      if (property === 'item' && isNodeCall(object)) { item = 'CURRENT'; node = object; continue; }
      if (path.length >= MAX_PATH_SEGMENTS) return unknown('PATH_TOO_LONG');
      path.unshift(property);
      node = object;
      continue;
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (isAstNode(callee) && callee.type === 'MemberExpression') {
        const method = isIdentifier(callee.property, 'first') || isIdentifier(callee.property, 'last')
          || isIdentifier(callee.property, 'all') || isIdentifier(callee.property, 'item')
          ? (callee.property as AstNode).name as string : undefined;
        if (method !== undefined) {
          if (!isSelectorBase(callee.object)) return unknown('UNSUPPORTED_CHAIN');
          if (Array.isArray(node.arguments) && node.arguments.length > 0) {
            return unknown('UNSUPPORTED_CALL', null, isNodeCall(callee.object) ? 'NODE' : 'CURRENT_INPUT');
          }
          if (selectorSeen) return unknown('CHAINED_SELECTOR', null, 'NODE');
          selectorSeen = true;
          item = SELECTORS[method]!;
          node = callee.object;
          continue;
        }
        return unknown('UNSUPPORTED_CALL', null, isNodeCall(callee.object) ? 'NODE' : 'CURRENT_INPUT');
      }
      if (isIdentifier(callee, '$')) {
        const label = Array.isArray(node.arguments) && node.arguments.length === 1 ? resolveStaticName(node.arguments[0]) : undefined;
        return label === undefined ? unknown('DYNAMIC_LABEL', null, 'NODE') : finish(label, path, item, labels);
      }
      return unknown('UNSUPPORTED_CALL');
    }
    if (isIdentifier(node, '$json') || isIdentifier(node, '$input')) return finishCurrent(path, item);
    if (isIdentifier(node, '$node')) return unknown('MISSING_LABEL');
    return unknown('UNSUPPORTED_ROOT');
  }
}

function finish(label: string, path: string[], item: ItemSelector, labels?: LabelIndex): StaticReference {
  const count = labels === undefined ? undefined : labels.get(label) ?? 0;
  if (count !== undefined && count !== 1) return unknown(count === 0 ? 'MISSING_LABEL' : 'AMBIGUOUS_LABEL', label);
  return finalize(label, path, item);
}
function finishCurrent(path: string[], item: ItemSelector): StaticReference {
  return finalize(null, path, item);
}
function finalize(label: string | null, path: string[], item: ItemSelector): StaticReference {
  const kind = label === null ? 'CURRENT_INPUT' as const : 'NODE' as const;
  if (item === 'ALL') return Object.freeze({ nodeLabel: label, path: Object.freeze([...path]), item, kind, status: 'BROAD', reason: 'ALL_COLLECTION' });
  if (path.length === 0) return Object.freeze({ nodeLabel: label, path: Object.freeze([]), item, kind, status: 'BROAD', reason: 'NO_PATH' });
  return Object.freeze({ nodeLabel: label, path: Object.freeze([...path]), item, kind, status: 'EXACT', reason: null });
}

function nodeLabelOf(property: string): string {
  return property;
}
function staticMember(node: AstNode): string | undefined {
  if (!node.computed) return typeof (node.property as AstNode | undefined)?.name === 'string' ? (node.property as AstNode).name as string : undefined;
  return resolveStaticName(node.property);
}
function isIdentifier(value: unknown, name: string): boolean {
  return isAstNode(value) && value.type === 'Identifier' && value.name === name;
}
function isNodeCall(value: unknown): boolean {
  return isAstNode(value) && value.type === 'CallExpression' && isIdentifier(value.callee, '$');
}
function isSelectorBase(value: unknown): boolean {
  if (isIdentifier(value, '$input')) return true;
  if (isNodeCall(value)) return true;
  return isSelectorCall(value);
}
function isSelectorCall(value: unknown): boolean {
  if (!isAstNode(value) || value.type !== 'CallExpression') return false;
  const callee = value.callee;
  return isAstNode(callee) && callee.type === 'MemberExpression'
    && (isIdentifier(callee.property, 'first') || isIdentifier(callee.property, 'last')
      || isIdentifier(callee.property, 'all') || isIdentifier(callee.property, 'item'));
}
