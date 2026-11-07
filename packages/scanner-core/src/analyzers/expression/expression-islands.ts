export type ExpressionIslandV2 = Readonly<{
  kind: 'LITERAL' | 'EXPRESSION';
  start: number;
  end: number;
}>;

export type Island = Readonly<{ startUtf16: number; endUtf16: number; bodyStartUtf16: number; bodyEndUtf16: number }>;
export type Islands = Readonly<{ islands: readonly Island[]; status: 'COMPLETE' | 'MALFORMED' | 'LIMITED'; work: number }>;

const MAX_LEXER_STACK_DEPTH = 256;

type Frame =
  | { kind: 'EXPRESSION' | 'TEMPLATE_EXPRESSION'; braces: number }
  | { kind: 'TEMPLATE' | 'SINGLE' | 'DOUBLE' };

const literal = (start: number, end: number): ExpressionIslandV2 => Object.freeze({ kind: 'LITERAL', start, end });
const expression = (start: number, end: number): ExpressionIslandV2 => Object.freeze({ kind: 'EXPRESSION', start, end });

/** Segment n8n expression islands without evaluating or exposing their contents. */
export function segmentExpressionIslands(value: string): readonly ExpressionIslandV2[] {
  if (typeof value !== 'string' || value.length === 0) return Object.freeze([]);
  const segments: ExpressionIslandV2[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{{', cursor);
    if (open < 0) break;
    if (open > cursor) segments.push(literal(cursor, open));
    const end = scanIsland(value, open + 2).end;
    segments.push(expression(open, end));
    cursor = end;
    if (end >= value.length) break;
  }
  if (cursor < value.length) segments.push(literal(cursor, value.length));
  if (segments.length === 0) segments.push(literal(0, value.length));
  return Object.freeze(segments);
}

function scanIsland(source: string, start: number): { end: number; closed: boolean } {
  const frames: Frame[] = [{ kind: 'EXPRESSION', braces: 0 }];
  let index = start;
  while (index < source.length && frames.length > 0) {
    const frame = frames[frames.length - 1];
    const character = source[index];
    if (frame.kind === 'EXPRESSION' || frame.kind === 'TEMPLATE_EXPRESSION') {
      if (character === '/' && source[index + 1] === '/') {
        const commentStart = index;
        const line = source.indexOf('\n', index + 2);
        index = line < 0 ? source.length : line + 1;
        let resume = index;
        while (resume < source.length && /\s/u.test(source[resume]!)) resume += 1;
        // A regex after a line comment is lexed from the token before the comment,
        // not from the comment text the scanner just skipped.
        if (source[resume] === '/' && source[resume + 1] !== '/' && source[resume + 1] !== '*'
          && regexMayStart(source, commentStart)) {
          index = skipRegex(source, resume);
        }
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue;
      }
      if (character === '/' && regexMayStart(source, index)) { index = skipRegex(source, index); continue; }
    }
    if (frame.kind === 'SINGLE' || frame.kind === 'DOUBLE') {
      if (character === '\\') { index += 2; continue; }
      const quote = frame.kind === 'SINGLE' ? "'" : '"';
      if (character === quote) frames.pop();
      index += 1;
      continue;
    }
    if (frame.kind === 'TEMPLATE') {
      if (character === '\\') { index += 2; continue; }
      if (character === '`') { frames.pop(); index += 1; continue; }
      if (character === '$' && source[index + 1] === '{') {
        if (frames.length >= MAX_LEXER_STACK_DEPTH) return { end: source.length, closed: false };
        frames.push({ kind: 'TEMPLATE_EXPRESSION', braces: 0 }); index += 2; continue;
      }
      index += 1;
      continue;
    }
    if (character === "'") { frames.push({ kind: 'SINGLE' }); index += 1; continue; }
    if (character === '"') { frames.push({ kind: 'DOUBLE' }); index += 1; continue; }
    if (character === '`') { frames.push({ kind: 'TEMPLATE' }); index += 1; continue; }
    if (frame.kind !== 'EXPRESSION' && frame.kind !== 'TEMPLATE_EXPRESSION') {
      index += 1;
      continue;
    }
    if (character === '{') { frame.braces += 1; index += 1; continue; }
    if (character === '}') {
      if (frame.braces > 0) { frame.braces -= 1; index += 1; continue; }
      if (frame.kind === 'TEMPLATE_EXPRESSION') { frames.pop(); index += 1; continue; }
      if (source[index + 1] === '}') return { end: index + 2, closed: true };
    }
    index += 1;
  }
  return { end: source.length, closed: false };
}


/** Normalized island view with bounded work. Uses the same lexer as segmentation. */
export function expressionIslands(text: string, maxWork: number): Islands {
  if (typeof text !== 'string' || text.length === 0) return Object.freeze({ islands: Object.freeze([]), status: 'COMPLETE', work: 0 });
  if (!Number.isSafeInteger(maxWork) || maxWork < 0) throw new TypeError('maxWork must be a non-negative safe integer');
  const limited = text.length > maxWork;
  const examined = limited ? text.slice(0, maxWork) : text;
  let malformed = false;
  const islands: Island[] = [];
  let cursor = 0;
  while (cursor < examined.length) {
    const open = examined.indexOf('{{', cursor);
    if (open < 0) break;
    const scanned = scanIsland(examined, open + 2);
    if (!scanned.closed) malformed = true;
    islands.push(Object.freeze({
      startUtf16: open, endUtf16: scanned.end,
      bodyStartUtf16: open + 2, bodyEndUtf16: scanned.closed ? scanned.end - 2 : scanned.end,
    }));
    cursor = scanned.end;
  }
  return Object.freeze({ islands: Object.freeze(islands), status: limited ? 'LIMITED' : malformed ? 'MALFORMED' : 'COMPLETE', work: examined.length });
}


function regexMayStart(source: string, index: number): boolean {
  let prior = index - 1;
  for (;;) {
    while (prior >= 0 && /\s/.test(source[prior]!)) prior -= 1;
    if (prior > 0 && source[prior] === '/' && source[prior - 1] === '*') {
      const start = source.lastIndexOf('/*', prior - 1);
      prior = start - 1;
      continue;
    }
    break;
  }
  return prior < 0 || '([{=,:;!&|?+-*%^~<>'.includes(source[prior]!);
}

function skipRegex(source: string, index: number): number {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') { cursor += 2; continue; }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) return cursor + 1;
    else if (character === '\n') return cursor;
    cursor += 1;
  }
  return source.length;
}
