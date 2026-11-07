export type Token = { kind: 'identifier' | 'literal' | 'operator'; value: string };

const MULTI_OPERATORS = ['===', '!==', '>>>', '**', '&&', '||', '??', '==', '!=', '<=', '>=', '=>', '?.'];

/** Browser-safe lexical support for the expression subset used by taint references. */
export function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') {
      const parsed = readString(source, index);
      if (parsed === undefined) return undefined;
      tokens.push({ kind: 'literal', value: parsed.value });
      index = parsed.next;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index) });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index++;
      while (index < source.length && /[0-9.eE_]/.test(source[index])) index += 1;
      tokens.push({ kind: 'literal', value: source.slice(start, index).replaceAll('_', '') });
      continue;
    }
    const operator = MULTI_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: 'operator', value: operator });
      index += operator.length;
      continue;
    }
    if ('.,()[]{}:+-*/%!<>?=&|^'.includes(char)) {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function readString(source: string, start: number): { value: string; next: number } | undefined {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) return { value, next: index + 1 };
    if (char !== '\\') { value += char; continue; }
    const escaped = source[++index];
    if (escaped === undefined) return undefined;
    value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[escaped] ?? escaped;
  }
  return undefined;
}
