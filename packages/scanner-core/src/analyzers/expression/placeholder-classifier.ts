import { classifierPattern, PROVIDER_TOKEN_PATTERNS } from '../../provider-token-patterns';

export type PlaceholderClassificationV2 = Readonly<{
  kind: 'PLACEHOLDER';
  indicator: string;
}>;

const MAX_PLACEHOLDER_LENGTH = 256;
const MAX_DYNAMIC_PROPERTY_LENGTH = 128;
const dynamicRootNames = new Set(['json', 'node', 'env', 'credentials', 'secrets', 'vars', 'parameter']);
const placeholderWords = '(?:your|my|example|sample|placeholder|dummy|test|fake|changeme|todo|insert|replace|enter|add)';
const placeholderNouns = '(?:api|access|auth|secret|token|key|password|credential|value|here|id|url|name)';
const wordPlaceholder = new RegExp(`^${placeholderWords}(?:[\\s_-]+(?:${placeholderWords}|${placeholderNouns}))*$`, 'i');
const nounPlaceholder = new RegExp(`^${placeholderNouns}(?:[\\s_-]+(?:${placeholderWords}|${placeholderNouns}))*$`, 'i');
const wrappedPlaceholder = /^<([^>\r\n]{1,256})>$/;
const bracketPlaceholder = /^\[([^\]\r\n]{1,256})\]$/;
const namedPlaceholder = new RegExp(`^__(?:${placeholderWords}|${placeholderNouns})(?:[_-](?:${placeholderWords}|${placeholderNouns}))*__$`, 'i');
const maskPlaceholder = /^[*x._-]{3,64}$/i;
const classifiedProviderPatterns = PROVIDER_TOKEN_PATTERNS.filter((entry) => entry.surfaces.some((surface) => surface === 'classify'));

/** Classify only complete, reviewed placeholder forms; never return the input text. */
export function classifyAnchoredPlaceholder(value: unknown): PlaceholderClassificationV2 | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_PLACEHOLDER_LENGTH) return undefined;
  const angle = wrappedPlaceholder.exec(candidate);
  if (angle && isReviewedPlaceholderInner(angle[1]) && !isProviderToken(angle[1])) return Object.freeze({ kind: 'PLACEHOLDER', indicator: 'ANGLE_WRAPPED' });
  const square = bracketPlaceholder.exec(candidate);
  if (square && isReviewedPlaceholderInner(square[1]) && !isProviderToken(square[1])) return Object.freeze({ kind: 'PLACEHOLDER', indicator: 'SQUARE_WRAPPED' });
  const indicator = namedPlaceholder.test(candidate)
    ? 'NAMED_PLACEHOLDER'
    : maskPlaceholder.test(candidate)
      ? 'MASK'
      : isDynamicRootPlaceholder(candidate)
        ? 'DYNAMIC_ROOT'
        : wordPlaceholder.test(candidate) || nounPlaceholder.test(candidate)
          ? 'PLACEHOLDER_WORD'
          : undefined;
  return indicator === undefined ? undefined : Object.freeze({ kind: 'PLACEHOLDER', indicator });
}

function isReviewedPlaceholderInner(value: string): boolean {
  return namedPlaceholder.test(value) || maskPlaceholder.test(value) || isDynamicRootPlaceholder(value)
    || wordPlaceholder.test(value) || nounPlaceholder.test(value);
}

function isProviderToken(value: string): boolean {
  return classifiedProviderPatterns.some((entry) => classifierPattern(entry).test(value));
}

function isDynamicRootPlaceholder(value: string): boolean {
  if (value.length > MAX_PLACEHOLDER_LENGTH) return false;
  let cursor = value.startsWith('$') ? 1 : 0;
  const rootStart = cursor;
  while (cursor < value.length && isDynamicIdentifierPart(value[cursor])) cursor += 1;
  if (!dynamicRootNames.has(value.slice(rootStart, cursor).toLowerCase())) return false;

  while (cursor < value.length) {
    if (value[cursor] === '.') {
      cursor += 1;
      if (cursor >= value.length || !isDynamicIdentifierStart(value[cursor])) return false;
      cursor += 1;
      while (cursor < value.length && isDynamicIdentifierPart(value[cursor])) cursor += 1;
      continue;
    }
    if (value[cursor] !== '[') return false;
    const quote = value[cursor + 1];
    if (quote !== '"' && quote !== "'") return false;
    cursor += 2;
    const propertyStart = cursor;
    let escaped = false;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === '\r' || character === '\n') return false;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        break;
      }
      cursor += 1;
    }
    if (cursor >= value.length || cursor - propertyStart === 0 || cursor - propertyStart > MAX_DYNAMIC_PROPERTY_LENGTH) return false;
    if (value[cursor + 1] !== ']') return false;
    cursor += 2;
  }
  return true;
}

function isDynamicIdentifierStart(character: string): boolean {
  return character === '$' || character === '_' || isAsciiLetter(character);
}

function isDynamicIdentifierPart(character: string): boolean {
  return isDynamicIdentifierStart(character) || isAsciiDigit(character);
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function isAsciiDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}
