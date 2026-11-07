import { tokenize, type Token } from './expression-tokenizer';
import type { AstNode } from './taint-expression-references';

const BINARY_PRECEDENCE: ReadonlyMap<string, number> = new Map([
  ['||', 1], ['??', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5],
  ['==', 6], ['!=', 6], ['===', 6], ['!==', 6], ['<', 7], ['>', 7],
  ['<=', 7], ['>=', 7], ['in', 7], ['+', 8], ['-', 8], ['*', 9],
  ['/', 9], ['%', 9], ['**', 10],
]);

/** A small parser keeps this package dependency-free; unsupported syntax fails closed. */
export function parseExpression(source: string): AstNode | undefined {
  const tokens = tokenize(source);
  if (tokens === undefined) return undefined;
  const parser = new Parser(tokens);
  const expression = parser.expression(0);
  return expression && parser.atEnd() ? expression : undefined;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean { return this.index === this.tokens.length; }

  expression(minPrecedence: number): AstNode | undefined {
    let left = this.prefix();
    if (left === undefined) return undefined;
    while (true) {
      const token = this.peek();
      const operator = token?.value;
      const precedence = operator === undefined ? undefined : BINARY_PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index += 1;
      const right = this.expression(precedence + (operator === '**' ? 0 : 1));
      if (right === undefined) return undefined;
      left = { type: 'BinaryExpression', operator, left, right };
    }
    if (minPrecedence === 0 && this.match('?')) {
      const consequent = this.expression(0);
      if (!this.match(':')) return undefined;
      const alternate = this.expression(0);
      if (consequent === undefined || alternate === undefined) return undefined;
      left = { type: 'ConditionalExpression', test: left, consequent, alternate };
    }
    return left;
  }

  private prefix(): AstNode | undefined {
    const token = this.peek();
    if (token === undefined) return undefined;
    if (['!', '+', '-', '~', 'typeof', 'void', 'delete', 'await'].includes(token.value)) {
      this.index += 1;
      const argument = this.expression(11);
      return argument ? { type: 'UnaryExpression', operator: token.value, argument } : undefined;
    }
    if (token.value === 'new') {
      this.index += 1;
      const callee = this.primary();
      return callee ? { type: 'NewExpression', callee, arguments: [] } : undefined;
    }
    return this.primary();
  }

  private primary(): AstNode | undefined {
    const token = this.peek();
    if (token === undefined) return undefined;
    this.index += 1;
    if (token.kind === 'identifier') return this.postfix({ type: 'Identifier', name: token.value });
    if (token.kind === 'literal') {
      const value = /^\d/.test(token.value) ? Number(token.value) : token.value;
      return this.postfix({ type: 'Literal', value });
    }
    if (token.value === '(') {
      const expression = this.expression(0);
      if (!this.match(')') || expression === undefined) return undefined;
      return this.postfix(expression);
    }
    if (token.value === '[') return this.arrayExpression();
    if (token.value === '{') return this.objectExpression();
    return undefined;
  }

  private postfix(base: AstNode): AstNode | undefined {
    let expression = base;
    while (true) {
      const token = this.peek();
      if (!token) return expression;
      if (token.value === '.' || token.value === '?.') {
        this.index += 1;
        const property = this.peek();
        if (!property || property.kind !== 'identifier') return undefined;
        this.index += 1;
        expression = { type: 'MemberExpression', object: expression, property: { type: 'Identifier', name: property.value }, computed: false };
      } else if (token.value === '[') {
        this.index += 1;
        const property = this.expression(0);
        if (!this.match(']') || property === undefined) return undefined;
        expression = { type: 'MemberExpression', object: expression, property, computed: true };
      } else if (token.value === '(') {
        const args = this.argumentsList();
        if (args === undefined) return undefined;
        expression = { type: 'CallExpression', callee: expression, arguments: args };
      } else break;
    }
    return expression;
  }

  private argumentsList(): AstNode[] | undefined {
    this.index += 1;
    const args: AstNode[] = [];
    while (!this.match(')')) {
      const argument = this.expression(0);
      if (argument === undefined) return undefined;
      args.push(argument);
      if (!this.match(',') && this.peek()?.value !== ')') return undefined;
    }
    return args;
  }

  private arrayExpression(): AstNode {
    const elements: Array<AstNode | null> = [];
    while (!this.match(']')) {
      const element = this.expression(0);
      elements.push(element ?? null);
      if (!this.match(',')) break;
    }
    return { type: 'ArrayExpression', elements };
  }

  private objectExpression(): AstNode {
    const properties: AstNode[] = [];
    while (!this.match('}')) {
      const key = this.primary();
      if (!key) break;
      const value = this.match(':') ? this.expression(0) : key;
      if (value) properties.push({ type: 'Property', key, value });
      if (!this.match(',')) break;
    }
    return { type: 'ObjectExpression', properties };
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private match(value: string): boolean {
    if (this.peek()?.value !== value) return false;
    this.index += 1;
    return true;
  }
}
