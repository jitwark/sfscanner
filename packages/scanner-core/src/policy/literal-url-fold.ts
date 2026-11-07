/** Bounded literal-only folding for n8n expression-mode URL parameters. */
export const MAX_FOLDED_LITERAL_CHARS = 4096;

class FoldError extends Error {}
type Cursor = { value: string; index: number };

function skipSpace(cursor: Cursor): void {
  while (/\s/u.test(cursor.value[cursor.index] ?? '')) cursor.index += 1;
}
function readString(cursor: Cursor, quote: "'" | '"'): string {
  if (cursor.value[cursor.index] !== quote) throw new FoldError();
  cursor.index += 1;
  let result = '';
  for (;;) {
    const character = cursor.value[cursor.index];
    if (character === undefined) throw new FoldError();
    cursor.index += 1;
    if (character === quote) return result;
    if (character !== '\\') { result += character; continue; }
    cursor.index -= 1;
    result += readEscape(cursor);
  }
}
function readEscape(cursor: Cursor): string {
  cursor.index += 1;
  const escape = cursor.value[cursor.index];
  if (escape === undefined) throw new FoldError();
  cursor.index += 1;
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (escape in simple) return simple[escape]!;
  if (escape === 'x' || escape === 'u') {
    const length = escape === 'x' ? 2 : 4;
    const hex = cursor.value.slice(cursor.index, cursor.index + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`, 'u').test(hex)) throw new FoldError();
    cursor.index += length;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }
  return escape;
}
function readTemplate(cursor: Cursor): string {
  cursor.index += 1;
  let result = '';
  for (;;) {
    const character = cursor.value[cursor.index];
    if (character === undefined) throw new FoldError();
    if (character === '`') { cursor.index += 1; return result; }
    if (character === '\\') { result += readEscape(cursor); continue; }
    if (character === '$' && cursor.value[cursor.index + 1] === '{') {
      cursor.index += 2;
      skipSpace(cursor);
      const quote = cursor.value[cursor.index];
      if (quote !== "'" && quote !== '"') throw new FoldError();
      result += readString(cursor, quote);
      skipSpace(cursor);
      if (cursor.value[cursor.index] !== '}') throw new FoldError();
      cursor.index += 1;
      continue;
    }
    result += character;
    cursor.index += 1;
    if (result.length > MAX_FOLDED_LITERAL_CHARS) throw new FoldError();
  }
}
function readOperand(cursor: Cursor): string {
  skipSpace(cursor);
  const character = cursor.value[cursor.index];
  if (character === "'" || character === '"') return readString(cursor, character);
  if (character === '`') return readTemplate(cursor);
  throw new FoldError();
}
function fold(value: string): string {
  if (!value.startsWith('=')) throw new FoldError();
  const cursor: Cursor = { value: value.slice(1), index: 0 };
  let result = readOperand(cursor);
  for (;;) {
    skipSpace(cursor);
    if (cursor.index >= cursor.value.length) break;
    if (cursor.value[cursor.index] !== '+') throw new FoldError();
    cursor.index += 1;
    const next = readOperand(cursor);
    result += next;
    if (result.length > MAX_FOLDED_LITERAL_CHARS) throw new FoldError();
  }
  if (result.length > MAX_FOLDED_LITERAL_CHARS) throw new FoldError();
  return result;
}

export type FoldOutcome =
  | Readonly<{ state: 'FOUND'; value: string }>
  | Readonly<{ state: 'UNKNOWN'; reason: 'DYNAMIC' | 'UNSUPPORTED' | 'OVERSIZED' }>;

const DYNAMIC_TOKEN = /\$(?:json|node|env|credentials|secrets|vars|parameter|\(|\[)/u;

/** Preserves why an expression-mode literal could not be folded. */
export function foldLiteralOutcome(value: string): FoldOutcome {
  if (value.length > MAX_FOLDED_LITERAL_CHARS) return { state: 'UNKNOWN', reason: 'OVERSIZED' };
  try {
    return { state: 'FOUND', value: fold(value) };
  } catch {
    return { state: 'UNKNOWN', reason: DYNAMIC_TOKEN.test(value) ? 'DYNAMIC' : 'UNSUPPORTED' };
  }
}

/** Returns the fully folded literal, or `undefined` for dynamic/unsupported/oversized input. */
export function foldLiteralExpression(value: string): string | undefined {
  const outcome = foldLiteralOutcome(value);
  return outcome.state === 'FOUND' ? outcome.value : undefined;
}
