import ts from 'typescript';
import {
  DYNAMIC_DESCRIPTION,
  NESTING_LIMIT,
  evaluateValue,
  objectKey,
  resolveArrayLiteral,
  resolveObjectLiteral,
  unwrapExpression,
  type AstContext,
  type LiteralValue,
} from './metadata-ast.js';
import {
  isLimitReason,
  safeLabel,
  withResolved,
} from './metadata-description-guards.js';
import { canonicalVersions } from './metadata-versions.js';

/** A scoped description field: either an expression to evaluate or a dynamic member. */
export type ScopedField =
  | Readonly<{ kind: 'value'; expression: ts.Expression; depth: number }>
  | Readonly<{ kind: 'dynamic' }>;

export type ScopedFields = Readonly<{
  name?: ScopedField;
  version?: ScopedField;
  properties?: ScopedField;
}>;

type Failure = Readonly<{ ok: false; reason: string }>;

export type ScopedResult = Readonly<{ ok: true; fields: ScopedFields }> | Failure;

export type ParametersResult =
  | Readonly<{ ok: true; parameters: readonly string[]; partial: boolean }>
  | Failure;

export type DescriptionCandidate = Readonly<{
  nodeType: string;
  versions: readonly string[];
  parameters: readonly string[];
  diagnostics: readonly string[];
}>;

export type DescriptionResult =
  | Readonly<{ ok: true; candidate: DescriptionCandidate }>
  | Failure;

/**
 * Reads only `name`, `version`, and `properties` from a description object.
 * Every other member is skipped without evaluation. Every spread is resolved
 * before its fields are merged; an unresolvable spread is rejected because it
 * may supply any scoped field, regardless of its position. Later explicit
 * keys still win.
 */
export function readDescriptionFields(expression: ts.Expression, context: AstContext): ScopedResult {
  const resolution = resolveObjectLiteral(expression, context);
  if (!resolution.ok) {
    return isLimitReason(resolution.reason) ? resolution : { ok: false, reason: DYNAMIC_DESCRIPTION };
  }
  return withResolved(resolution.chain, context, () => readFields(resolution.node, resolution.depth, context));
}

/**
 * Extracts the candidate fields from a description expression. Missing or
 * invalid `name`/`version` reject the file; `properties` problems degrade to
 * empty or partial parameters with `PARTIAL_PARAMETERS`.
 */
export function extractDescription(expression: ts.Expression | null, context: AstContext): DescriptionResult {
  if (expression === null) return { ok: false, reason: DYNAMIC_DESCRIPTION };
  const scoped = readDescriptionFields(expression, context);
  if (!scoped.ok) return scoped;

  const nameField = scoped.fields.name;
  if (nameField === undefined) return { ok: false, reason: 'INVALID_NAME' };
  const name = readField(nameField, context, 'DYNAMIC_NAME');
  if (!name.ok) return name;
  const nodeType = safeLabel(name.value);
  if (nodeType === null) return { ok: false, reason: 'INVALID_NAME' };

  const versionField = scoped.fields.version;
  if (versionField === undefined) return { ok: false, reason: 'INVALID_VERSION' };
  const version = readField(versionField, context, 'DYNAMIC_VERSION');
  if (!version.ok) return version;
  const versions = canonicalVersions(version.value);
  if (versions === null) return { ok: false, reason: 'INVALID_VERSION' };

  const parameters = readParameters(scoped.fields.properties, context);
  if (!parameters.ok) return parameters;

  return {
    ok: true,
    candidate: {
      nodeType,
      versions,
      parameters: [...parameters.parameters].sort((left, right) => (
        left < right ? -1 : left > right ? 1 : 0
      )),
      diagnostics: parameters.partial ? ['PARTIAL_PARAMETERS'] : [],
    },
  };
}

function readFields(node: ts.ObjectLiteralExpression, depth: number, context: AstContext): ScopedResult {
  let fields: ScopedFields = {};
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveObjectLiteral(property.expression, context, depth + 1);
      if (!spread.ok) {
        return isLimitReason(spread.reason) ? spread : { ok: false, reason: DYNAMIC_DESCRIPTION };
      }
      const inner = withResolved(spread.chain, context, () => readFields(spread.node, spread.depth, context));
      if (!inner.ok) return inner;
      fields = { ...fields, ...inner.fields };
      continue;
    }

    const key = objectKey(property.name);
    if (key === null) return { ok: false, reason: DYNAMIC_DESCRIPTION };
    if (key !== 'name' && key !== 'version' && key !== 'properties') continue;

    if (ts.isPropertyAssignment(property)) {
      fields = { ...fields, [key]: { kind: 'value', expression: property.initializer, depth: depth + 1 } };
    } else if (ts.isShorthandPropertyAssignment(property)) {
      fields = { ...fields, [key]: { kind: 'value', expression: property.name, depth: depth + 1 } };
    } else {
      fields = { ...fields, [key]: { kind: 'dynamic' } };
    }
  }
  return { ok: true, fields };
}

/** Reads `properties[].name` only; every other element member is ignored. */
export function readParameters(field: ScopedField | undefined, context: AstContext): ParametersResult {
  if (field === undefined) return { ok: true, parameters: [], partial: false };
  if (field.kind === 'dynamic') return { ok: true, parameters: [], partial: true };

  const resolution = resolveArrayLiteral(field.expression, context, field.depth);
  if (!resolution.ok) {
    if (isLimitReason(resolution.reason)) return resolution;
    return { ok: true, parameters: [], partial: true };
  }
  if (resolution.depth + 1 > context.limits.maxLiteralDepth) {
    return { ok: false, reason: NESTING_LIMIT };
  }

  const parameters = new Set<string>();
  let partial = false;
  let spreadSeen = false;
  for (const element of resolution.node.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
      spreadSeen = true;
      partial = true;
      continue;
    }
    if (spreadSeen) {
      partial = true;
      continue;
    }
    const node = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(node)) {
      partial = true;
      continue;
    }
    const name = readElementName(node, context, resolution.depth + 1);
    if (!name.ok) {
      if (isLimitReason(name.reason)) return name;
      partial = true;
      continue;
    }
    if (name.value === null) {
      partial = true;
      continue;
    }
    parameters.add(name.value);
  }
  return { ok: true, parameters: [...parameters], partial };
}

function readElementName(
  node: ts.ObjectLiteralExpression,
  context: AstContext,
  elementDepth: number,
): Readonly<{ ok: true; value: string | null }> | Failure {
  let name: ScopedField | null = null;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      // A spread after the explicit name may override it; anything else is inert.
      if (name !== null) return { ok: true, value: null };
      continue;
    }
    const key = objectKey(property.name);
    if (key === null) return { ok: true, value: null };
    if (key !== 'name') continue;
    if (ts.isPropertyAssignment(property)) {
      name = { kind: 'value', expression: property.initializer, depth: elementDepth + 1 };
    } else if (ts.isShorthandPropertyAssignment(property)) {
      name = { kind: 'value', expression: property.name, depth: elementDepth + 1 };
    } else {
      name = { kind: 'dynamic' };
    }
  }
  if (name === null) return { ok: true, value: null };
  if (name.kind === 'dynamic') return { ok: true, value: null };

  const evaluated = evaluateValue(name.expression, context, name.depth);
  if (!evaluated.ok) {
    if (isLimitReason(evaluated.reason)) return evaluated;
    return { ok: true, value: null };
  }
  return { ok: true, value: safeLabel(evaluated.value) };
}

function readField(
  field: ScopedField,
  context: AstContext,
  dynamicReason: string,
): Readonly<{ ok: true; value: LiteralValue }> | Failure {
  if (field.kind === 'dynamic') return { ok: false, reason: dynamicReason };
  const evaluated = evaluateValue(field.expression, context, field.depth);
  if (evaluated.ok) return evaluated;
  if (isLimitReason(evaluated.reason)) return evaluated;
  return { ok: false, reason: dynamicReason };
}
