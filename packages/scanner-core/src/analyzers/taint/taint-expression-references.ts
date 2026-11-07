const MAX_PROPERTY_NAME_BYTES = 256;
const CURRENT_ITEM_ROOTS = new Set(['$json', '$binary', '$input', '$item']);
const NODE_ACCESSORS = new Set(['$', '$items', '$node']);

export type ExpressionReferenceRoot = 'CURRENT_ITEM' | 'NAMED_NODE' | 'DYNAMIC_NODE';
export type ExpressionReference = {
  root: ExpressionReferenceRoot;
  nodeName?: string;
  propertyPath?: string;
  pathComplete: boolean;
  wrapperCallees: string[];
};
export type AstNode = { type: string; [key: string]: unknown };
export type ResolvedChain = {
  reference: Omit<ExpressionReference, 'wrapperCallees'>;
  nested: unknown[];
};

export function resolveDataChain(node: AstNode): ResolvedChain | undefined {
  let segments: string[] = [];
  const nested: unknown[] = [];
  let pathComplete = true;
  let current: unknown = node;
  while (isAstNode(current) && current.type === 'MemberExpression') {
    const key = current.computed ? resolveStaticName(current.property) : identifierName(current.property);
    if (key === undefined) {
      pathComplete = false;
      segments = [];
      if (current.computed) nested.push(current.property);
    } else segments.unshift(key);
    current = current.object;
  }
  return isAstNode(current) ? referenceForBase(current, segments, nested, pathComplete) : undefined;
}

function referenceForBase(base: AstNode, segments: string[], nested: unknown[], pathComplete: boolean): ResolvedChain | undefined {
  const rootName = identifierName(base) ?? calleeName(base.callee);
  if (rootName === undefined) return undefined;
  if (base.type === 'Identifier' && CURRENT_ITEM_ROOTS.has(rootName)) {
    return { reference: { root: 'CURRENT_ITEM', ...pathOf(segments), pathComplete }, nested };
  }
  if (base.type === 'Identifier' && rootName === '$node') {
    const [nodeName, ...rest] = segments;
    return nodeName === undefined
      ? { reference: { root: 'DYNAMIC_NODE', pathComplete: false }, nested }
      : { reference: { root: 'NAMED_NODE', nodeName, ...pathOf(rest), pathComplete }, nested };
  }
  if (base.type === 'CallExpression' && NODE_ACCESSORS.has(rootName)) {
    const argument = asArray(base.arguments)[0];
    const nodeName = resolveStaticName(argument);
    if (nodeName === undefined) {
      nested.push(argument);
      return { reference: { root: 'DYNAMIC_NODE', pathComplete: false }, nested };
    }
    return { reference: { root: 'NAMED_NODE', nodeName, ...pathOf(segments), pathComplete }, nested };
  }
  return undefined;
}

function pathOf(segments: string[]): { propertyPath?: string } {
  return segments.length === 0 ? {} : { propertyPath: segments.join('.') };
}

export function resolveStaticName(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || !isAstNode(value)) return undefined;
  if (value.type === 'Literal') {
    const literal = value.value;
    if (typeof literal === 'string') return literal.length <= MAX_PROPERTY_NAME_BYTES ? literal : undefined;
    return typeof literal === 'number' ? String(literal) : undefined;
  }
  if (value.type !== 'BinaryExpression' || value.operator !== '+') return undefined;
  const left = resolveStaticName(value.left, depth + 1);
  const right = resolveStaticName(value.right, depth + 1);
  if (left === undefined || right === undefined || left.length + right.length > MAX_PROPERTY_NAME_BYTES) return undefined;
  return left + right;
}

export function calleeName(value: unknown): string | undefined {
  const direct = identifierName(value);
  if (direct !== undefined) return direct;
  if (!isAstNode(value) || value.type !== 'MemberExpression' || value.computed) return undefined;
  const object = identifierName(value.object);
  const property = identifierName(value.property);
  return object === undefined || property === undefined ? undefined : `${object}.${property}`;
}

function identifierName(value: unknown): string | undefined {
  return isAstNode(value) && value.type === 'Identifier' && typeof value.name === 'string' ? value.name : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as AstNode).type === 'string';
}
