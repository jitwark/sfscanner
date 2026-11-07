import { segmentExpressionIslands } from '../analyzers/expression/expression-islands';

export type LiteralIslands = Readonly<{ literals: string[]; templated: boolean }>;

/**
 * Splits a parameter value into the literal text it ships verbatim. n8n marks expression mode
 * with a leading `=` and evaluates `{{ … }}` islands at runtime, so both are stripped.
 */
export function literalIslands(value: string): LiteralIslands {
  const body = value.startsWith('=') ? value.slice(1) : value;
  const segments = segmentExpressionIslands(body);
  const literals = segments
    .filter((segment) => segment.kind === 'LITERAL' && segment.end > segment.start)
    .map((segment) => body.slice(segment.start, segment.end))
    .filter((island) => island.trim().length > 0);
  return { literals, templated: segments.some((segment) => segment.kind === 'EXPRESSION') };
}
