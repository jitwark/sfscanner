import { asArray, calleeName, isAstNode, resolveDataChain, type AstNode, type ExpressionReference } from './taint-expression-references';
import { parseExpression } from './expression-parser';
import { expressionIslands } from '../expression/expression-islands';
import { resolveStaticName } from './taint-expression-references';
import { resolveStaticReference, type ItemSelector, type LabelIndex } from '../expression/static-references';

export const MAX_EXPRESSION_SEGMENTS = 20;
export const MAX_EXPRESSION_SEGMENT_BYTES = 2_000;
export const MAX_EXPRESSION_AST_NODES = 2_000;
export const MAX_EXPRESSION_REFERENCES = 32;
export type { ExpressionReference, ExpressionReferenceRoot } from './taint-expression-references';
export type ExpressionDiagnosticCode = 'EXPRESSION_PARSE_FAILED' | 'ANALYSIS_LIMIT_EXCEEDED';
export type StaticExpressionReference = ExpressionReference & { item?: ItemSelector };
export type ParameterExpressionReading = { references: StaticExpressionReference[]; diagnostics: ExpressionDiagnosticCode[] };
type WalkState = { visited: number; limitExceeded: boolean };

export function readParameterExpressions(value: string, labels?: LabelIndex): ParameterExpressionReading {
  const references: StaticExpressionReference[] = [];
  const diagnostics = new Set<ExpressionDiagnosticCode>();
  const extraction = extractSegments(value);
  if (extraction.limitExceeded) diagnostics.add('ANALYSIS_LIMIT_EXCEEDED');
  for (const segment of extraction.segments) {
    if (new TextEncoder().encode(segment).length > MAX_EXPRESSION_SEGMENT_BYTES) {
      diagnostics.add('ANALYSIS_LIMIT_EXCEEDED');
      continue;
    }
    const diagnostic = readSegment(segment, references, labels);
    if (diagnostic) diagnostics.add(diagnostic);
  }
  return { references, diagnostics: [...diagnostics] };
}

function extractSegments(value: string): { segments: string[]; limitExceeded: boolean } {
  const result = expressionIslands(value, value.length);
  const segments = result.islands
    .filter((island) => island.endUtf16 - island.bodyEndUtf16 === 2)
    .slice(0, MAX_EXPRESSION_SEGMENTS)
    .map((island) => value.slice(island.bodyStartUtf16, island.bodyEndUtf16));
  return { segments, limitExceeded: result.status === 'LIMITED' || result.islands.length > MAX_EXPRESSION_SEGMENTS };
}

function readSegment(segment: string, references: StaticExpressionReference[], labels?: LabelIndex): ExpressionDiagnosticCode | undefined {
  const resolved = resolveStaticReference(segment, segment.length, labels);
  if (labels !== undefined && (resolved.reason === 'MISSING_LABEL' || resolved.reason === 'AMBIGUOUS_LABEL')) {
    references.push({ root: 'DYNAMIC_NODE', pathComplete: false, wrapperCallees: [] });
    return undefined;
  }
  if (resolved.reason === 'PARSE_ERROR') return 'EXPRESSION_PARSE_FAILED';
  const methodOnReference = resolved.reason === 'UNSUPPORTED_CALL' && isMethodOnReference(segment);
  const suppressed = resolved.reason === 'PATH_TOO_LONG' || resolved.reason === 'WORK_LIMIT'
    || resolved.reason === 'PARSE_LIMIT' || resolved.reason === 'CHAINED_SELECTOR' || methodOnReference;
  if (suppressed) return undefined;
  if (resolved.status !== 'UNKNOWN') {
    references.push({
      root: resolved.nodeLabel === null ? 'CURRENT_ITEM' : 'NAMED_NODE',
      ...(resolved.nodeLabel === null ? {} : { nodeName: resolved.nodeLabel }),
      ...(resolved.path.length === 0 ? {} : { propertyPath: resolved.path.join('.') }),
      pathComplete: resolved.status === 'EXACT' || (resolved.status === 'BROAD' && resolved.reason === 'NO_PATH'),
      ...(resolved.item === 'CURRENT' ? {} : { item: resolved.item }),
      wrapperCallees: [],
    });
    return undefined;
  }
  const program = parseExpression(segment);
  if (program === undefined) return 'EXPRESSION_PARSE_FAILED';
  const state: WalkState = { visited: 0, limitExceeded: false };
  const start = references.length;
  visit(program, [], references, state);
  const denied = new Set<string>();
  collectMethodOnReferenceNames(program, denied);
  if (denied.size > 0) {
    for (let index = references.length - 1; index >= start; index -= 1) {
      const last = references[index]?.propertyPath?.split('.').at(-1);
      if (last !== undefined && denied.has(last)) references.splice(index, 1);
    }
  }
  return state.limitExceeded ? 'ANALYSIS_LIMIT_EXCEEDED' : undefined;
}

function visit(node: unknown, chain: string[], references: StaticExpressionReference[], state: WalkState): void {
  if (!isAstNode(node)) return;
  state.visited += 1;
  if (state.visited > MAX_EXPRESSION_AST_NODES) { state.limitExceeded = true; return; }
  const resolved = resolveDataChain(node);
  if (resolved) {
    if (references.length >= MAX_EXPRESSION_REFERENCES) { state.limitExceeded = true; return; }
    references.push({ ...resolved.reference, wrapperCallees: [...chain] });
    for (const inner of resolved.nested) visit(inner, chain, references, state);
    return;
  }
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    visit(node.callee, chain, references, state);
    const callee = calleeName(node.callee);
    const argumentChain = callee === undefined ? chain : [...chain, callee];
    for (const argument of asArray(node.arguments)) visit(argument, argumentChain, references, state);
    return;
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((entry) => visit(entry, chain, references, state));
    else visit(child, chain, references, state);
  }
}


function isMethodOnReference(segment: string): boolean {
  const program = parseExpression(segment);
  if (!isAstNode(program) || program.type !== 'CallExpression') return false;
  const callee = program.callee;
  return isAstNode(callee) && callee.type === 'MemberExpression' && isReferenceChain(callee.object);
}
function isReferenceChain(value: unknown): boolean {
  if (!isAstNode(value)) return false;
  if (value.type === 'Identifier') return value.name === '$json' || value.name === '$input' || value.name === '$node';
  if (value.type === 'MemberExpression') return isReferenceChain(value.object);
  if (value.type === 'CallExpression') {
    if (isAstNode(value.callee) && value.callee.type === 'Identifier') return value.callee.name === '$';
    return isReferenceChain(value.callee);
  }
  return false;
}


function collectMethodOnReferenceNames(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((entry) => collectMethodOnReferenceNames(entry, into)); return; }
  if (!isAstNode(value)) return;
  if (value.type === 'CallExpression') {
    const callee = value.callee;
    if (isAstNode(callee) && callee.type === 'MemberExpression' && isReferenceChain(callee.object)) {
      const method = callee.computed ? resolveStaticName(callee.property)
        : isAstNode(callee.property) && typeof callee.property.name === 'string' ? callee.property.name : undefined;
      if (method !== undefined) into.add(method);
    }
  }
  for (const child of Object.values(value)) collectMethodOnReferenceNames(child, into);
}
