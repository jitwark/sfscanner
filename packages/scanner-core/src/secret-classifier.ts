import { segmentExpressionIslands } from './analyzers/expression/expression-islands';
import { classifyAnchoredPlaceholder } from './analyzers/expression/placeholder-classifier';
import { classifyProviderToken } from './analyzers/secrets/provider-token-registry';

const MAX_SECRET_VALUE_CHARS = 4_096;
export const MAX_SECRET_INDICATORS = 10;
const opaqueSecretSyntax = /^[A-Za-z0-9~+/=_!$.-]{20,512}$/;
const sensitiveContext = /(?:api[-_ ]?key|token|secret|password|credential|authorization|cookie)/i;

export type SecretClassification = Readonly<{ kind: string }>;
export type LiteralClassification = Readonly<{
  classification?: SecretClassification;
  indicatorCount: number;
  omitted: boolean;
}>;

/**
 * Classifies bounded literal values without returning their contents. Expression code is not
 * evaluated; complete provider tokens in quoted string values are classified, while each
 * surrounding literal is considered independently.
 */
export function classifySecretValue(
  value: string,
  contextKey?: string,
): SecretClassification | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_SECRET_VALUE_CHARS) return undefined;
  return classifyLiteralSegments(candidate, contextKey).classification;
}

export function classifyLiteralSegments(value: string, contextKey?: string): LiteralClassification {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_VALUE_CHARS) {
    return Object.freeze({ classification: undefined, indicatorCount: 0, omitted: false });
  }
  // n8n marks expression mode with a leading `=`; the marker is not part of the value.
  const body = value.startsWith('=') ? value.slice(1) : value;
  let classification: SecretClassification | undefined;
  let indicatorCount = 0;
  let omitted = false;
  for (const segment of segmentExpressionIslands(body)) {
    if (segment.kind === 'EXPRESSION') {
      const found: SecretClassification[] = [];
      collectQuotedExpressionTokens(body, segment.start, segment.end, found);
      for (const providerClassification of found) {
        if (indicatorCount >= MAX_SECRET_INDICATORS) { omitted = true; continue; }
        indicatorCount += 1;
        classification ??= providerClassification;
      }
      continue;
    }
    if (segment.end <= segment.start) continue;
    const found = classifyLiteral(body.slice(segment.start, segment.end), contextKey);
    if (found === undefined) continue;
    if (indicatorCount >= MAX_SECRET_INDICATORS) { omitted = true; continue; }
    indicatorCount += 1;
    classification ??= found;
  }
  return Object.freeze({ classification, indicatorCount, omitted });
}

/**
 * Classifies complete provider tokens inside single- or double-quoted string values of n8n
 * expressions. The expression is never evaluated; unquoted template-literal text and quoted
 * property names are not scanned, and escape sequences are not decoded (the raw two-character
 * escape is kept, so an escaped fragment cannot be spliced into a token).
 */
export function classifyQuotedExpressionTokens(value: string): readonly SecretClassification[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_VALUE_CHARS) {
    return Object.freeze([]);
  }
  const classifications: SecretClassification[] = [];
  for (const segment of segmentExpressionIslands(value)) {
    if (segment.kind !== 'EXPRESSION') continue;
    collectQuotedExpressionTokens(value, segment.start, segment.end, classifications);
    if (classifications.length >= MAX_SECRET_INDICATORS) break;
  }
  return Object.freeze(classifications);
}

function collectQuotedExpressionTokens(
  source: string,
  start: number,
  end: number,
  output: SecretClassification[],
): void {
  let index = start;
  while (index < end && output.length < MAX_SECRET_INDICATORS) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") { index += 1; continue; }
    const opening = index;
    let literal = '';
    index += 1;
    while (index < end) {
      const character = source[index];
      if (character === '\\') {
        // Keep the backslash with its escaped character: dropping it turns `\n` into `n` and
        // can splice two fragments into a provider token the runtime never holds.
        if (index + 1 < end) literal += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === quote) break;
      literal += character;
      index += 1;
    }
    const closing = index;
    const closed = closing < end && source[closing] === quote;
    index += 1;
    if (!closed || isQuotedPropertyName(source, opening, closing, start, end)) continue;
    const classification = classifyProviderToken(literal);
    if (classification) output.push(classification);
  }
}

function isQuotedPropertyName(
  source: string,
  opening: number,
  closing: number,
  start: number,
  end: number,
): boolean {
  const previous = previousNonWhitespace(source, opening - 1, start);
  const next = nextNonWhitespace(source, closing + 1, end);
  if (next === ':' && (previous === '{' || previous === ',')) return true;
  if (previous !== '[') return false;
  const owner = previousNonWhitespace(source, opening - 2, start);
  return owner !== undefined && /[A-Za-z0-9_$.)\].'"`]/.test(owner);
}

function previousNonWhitespace(source: string, index: number, lowerBound: number): string | undefined {
  for (let cursor = index; cursor >= lowerBound; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return undefined;
}

function nextNonWhitespace(source: string, index: number, upperBound: number): string | undefined {
  for (let cursor = index; cursor < upperBound; cursor += 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return undefined;
}

function classifyLiteral(value: string, contextKey?: string): SecretClassification | undefined {
  const candidate = value.trim();
  if (candidate.length === 0 || isDynamicReference(candidate)) return undefined;
  const provider = classifyProviderToken(candidate);
  if (provider) return provider;
  if (classifyAnchoredPlaceholder(candidate)) return undefined;
  if (!contextKey || !sensitiveContext.test(contextKey) || !opaqueSecretSyntax.test(candidate)) return undefined;
  return shannonEntropy(candidate) >= 3.5 ? Object.freeze({ kind: 'opaque secret' }) : undefined;
}

function isDynamicReference(value: string): boolean {
  return value.includes('${') || value.startsWith('=');
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}
