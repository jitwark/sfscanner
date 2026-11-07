import ts from 'typescript';

/** A statically resolved value: scalars, arrays, and string-keyed objects only. */
export type LiteralValue =
  | Readonly<{ kind: 'scalar'; value: string | number | boolean | null; text?: string }>
  | Readonly<{ kind: 'array'; items: readonly LiteralValue[] }>
  | Readonly<{ kind: 'object'; entries: ReadonlyMap<string, LiteralValue> }>;

export type Evaluation =
  | Readonly<{ ok: true; value: LiteralValue }>
  | Readonly<{ ok: false; reason: string }>;

export type AstLimits = Readonly<{ maxConstantsPerFile: number; maxLiteralDepth: number; maxScalarUnits: number }>;
export type AstContext = {
  readonly sourceFile: ts.SourceFile;
  readonly constants: ReadonlyMap<string, ts.Expression>;
  readonly limits: AstLimits;
  readonly cache: Map<string, LiteralValue>;
  readonly resolving: Set<string>;
  scalars: number;
};
export type ContextResult = Readonly<{ ok: true; context: AstContext } | { ok: false; reason: string }>;
export type LiteralResolution<T extends ts.Expression> =
  | Readonly<{ ok: true; node: T; depth: number; chain: readonly string[] }>
  | Readonly<{ ok: false; reason: string }>;

export const DYNAMIC_VALUE = 'DYNAMIC_VALUE';
export const DYNAMIC_PROPERTY = 'DYNAMIC_PROPERTY';
export const DYNAMIC_DESCRIPTION = 'DYNAMIC_DESCRIPTION';
export const CONSTANT_CYCLE = 'CONSTANT_CYCLE';
export const CONSTANT_LIMIT = 'CONSTANT_LIMIT';
export const NESTING_LIMIT = 'NESTING_LIMIT';
export const SCALAR_LIMIT = 'SCALAR_LIMIT';
const fail = (reason: string): Evaluation => ({ ok: false, reason });
export function countNodes(sourceFile: ts.SourceFile): number {
  const stack: ts.Node[] = [sourceFile];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return count;
}

/** Collects top-level `const name = ...` declarations in source order; first declaration wins. */
export function createAstContext(sourceFile: ts.SourceFile, limits: AstLimits): ContextResult {
  const constants = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined || !ts.isIdentifier(declaration.name)) continue;
      if (!constants.has(declaration.name.text)) {
        constants.set(declaration.name.text, declaration.initializer);
      }
      if (constants.size > limits.maxConstantsPerFile) return { ok: false, reason: CONSTANT_LIMIT };
    }
  }
  return {
    ok: true,
    context: { sourceFile, constants, limits, cache: new Map(), resolving: new Set(), scalars: 0 },
  };
}

/**
 * Finds description sources in AST order: class property initializers and
 * `this.description = ...` assignments inside constructors. `null` marks a
 * present-but-dynamic description such as a getter or method.
 */
export function findDescriptionExpressions(sourceFile: ts.SourceFile): (ts.Expression | null)[] {
  const found: (ts.Expression | null)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member)) {
          if (isNamed(member.name, 'description') && member.initializer !== undefined) {
            found.push(member.initializer);
          }
        } else if ((ts.isGetAccessor(member) || ts.isSetAccessor(member) || ts.isMethodDeclaration(member))
          && isNamed(member.name, 'description')) {
          found.push(null);
        }
      }
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
          collectConstructorAssignments(member.body, found);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function resolveObjectLiteral(
  expression: ts.Expression,
  context: AstContext,
  depth = 0,
): LiteralResolution<ts.ObjectLiteralExpression> {
  return resolveLiteral(expression, context, depth, [], ts.isObjectLiteralExpression);
}

export function resolveArrayLiteral(
  expression: ts.Expression,
  context: AstContext,
  depth = 0,
): LiteralResolution<ts.ArrayLiteralExpression> {
  return resolveLiteral(expression, context, depth, [], ts.isArrayLiteralExpression);
}

/** Evaluates one value expression; `depth` is the container depth of that expression. */
export function evaluateValue(expression: ts.Expression, context: AstContext, depth: number): Evaluation {
  return evaluateExpression(expression, context, depth);
}

export function objectKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function resolveLiteral<T extends ts.Expression>(
  expression: ts.Expression,
  context: AstContext,
  depth: number,
  chain: readonly string[],
  matches: (node: ts.Expression) => node is T,
): LiteralResolution<T> {
  const node = unwrapExpression(expression);
  if (matches(node)) return { ok: true, node, depth, chain };
  if (!ts.isIdentifier(node)) return { ok: false, reason: DYNAMIC_DESCRIPTION };

  const nextDepth = depth + 1;
  if (nextDepth > context.limits.maxLiteralDepth) return { ok: false, reason: NESTING_LIMIT };
  const initializer = context.constants.get(node.text);
  if (initializer === undefined) return { ok: false, reason: DYNAMIC_DESCRIPTION };
  if (context.resolving.has(node.text) || chain.includes(node.text)) {
    return { ok: false, reason: CONSTANT_CYCLE };
  }
  return resolveLiteral(initializer, context, nextDepth, [...chain, node.text], matches);
}

function evaluateExpression(expression: ts.Expression, context: AstContext, depth: number): Evaluation {
  if (depth > context.limits.maxLiteralDepth) return fail(NESTING_LIMIT);
  const node = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(node)) return evaluateObject(node, context, depth);
  if (ts.isArrayLiteralExpression(node)) return evaluateArray(node, context, depth);
  if (ts.isStringLiteral(node)) return evaluateScalar(node.text, context);
  if (ts.isNumericLiteral(node)) return evaluateNumber(node.getText(context.sourceFile), 1);
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)
    && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)) {
    return evaluateNumber(
      node.operand.getText(context.sourceFile),
      node.operator === ts.SyntaxKind.MinusToken ? -1 : 1,
    );
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return evaluateScalar(true, context);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return evaluateScalar(false, context);
  if (node.kind === ts.SyntaxKind.NullKeyword) return evaluateScalar(null, context);
  if (ts.isIdentifier(node)) return evaluateConstant(node.text, context, depth);
  return fail(DYNAMIC_VALUE);
}

function evaluateConstant(name: string, context: AstContext, depth: number): Evaluation {
  if (depth > context.limits.maxLiteralDepth) return fail(NESTING_LIMIT);
  const cached = context.cache.get(name);
  if (cached !== undefined) return { ok: true, value: cached };
  const initializer = context.constants.get(name);
  if (initializer === undefined) return fail(DYNAMIC_VALUE);
  if (context.resolving.has(name)) return fail(CONSTANT_CYCLE);

  context.resolving.add(name);
  try {
    const result = evaluateExpression(initializer, context, depth + 1);
    if (result.ok) context.cache.set(name, result.value);
    return result;
  } finally {
    context.resolving.delete(name);
  }
}

function evaluateObject(node: ts.ObjectLiteralExpression, context: AstContext, depth: number): Evaluation {
  const entries = new Map<string, LiteralValue>();
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = objectKey(property.name);
      if (key === null) return fail(DYNAMIC_PROPERTY);
      const value = evaluateExpression(property.initializer, context, depth + 1);
      if (!value.ok) return value;
      entries.set(key, value.value);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const value = evaluateExpression(property.name, context, depth + 1);
      if (!value.ok) return value;
      entries.set(property.name.text, value.value);
    } else {
      return fail(DYNAMIC_PROPERTY);
    }
  }
  return { ok: true, value: { kind: 'object', entries } };
}

function evaluateArray(node: ts.ArrayLiteralExpression, context: AstContext, depth: number): Evaluation {
  const items: LiteralValue[] = [];
  for (const element of node.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return fail(DYNAMIC_VALUE);
    const value = evaluateExpression(element, context, depth + 1);
    if (!value.ok) return value;
    items.push(value.value);
  }
  return { ok: true, value: { kind: 'array', items } };
}

function evaluateNumber(text: string, sign: number): Evaluation {
  return {
    ok: true,
    value: { kind: 'scalar', value: sign * Number(text), text: sign < 0 ? `-${text}` : text },
  };
}

function evaluateScalar(value: string | number | boolean | null, context: AstContext): Evaluation {
  if (typeof value === 'string') {
    context.scalars += value.length;
    if (context.scalars > context.limits.maxScalarUnits) return fail(SCALAR_LIMIT);
  }
  return { ok: true, value: { kind: 'scalar', value } };
}

function isNamed(name: ts.PropertyName | undefined, expected: string): boolean {
  return name !== undefined && objectKey(name) === expected;
}

function collectConstructorAssignments(node: ts.Node, found: (ts.Expression | null)[]): void {
  if (ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left)
    && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    && node.left.name.text === 'description') {
    found.push(node.right);
    return;
  }
  ts.forEachChild(node, (child) => collectConstructorAssignments(child, found));
}
