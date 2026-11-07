import type ts from 'typescript';
import {
  NESTING_LIMIT,
  SCALAR_LIMIT,
  type AstContext,
  type LiteralValue,
} from './metadata-ast.js';

const MAX_LABEL_UNITS = 200;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function safeLabel(value: LiteralValue | undefined): string | null {
  if (value === undefined || value.kind !== 'scalar' || typeof value.value !== 'string') return null;
  const text = value.value;
  if (text.length === 0 || text.length > MAX_LABEL_UNITS || CONTROL_PATTERN.test(text)) return null;
  if (hasLoneSurrogate(text)) return null;
  return text;
}

/** True when a string holds an unpaired UTF-16 surrogate, which no UTF-8 source can encode. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function isLimitReason(reason: string): boolean {
  return reason === NESTING_LIMIT || reason === SCALAR_LIMIT;
}

export function withResolved<T>(chain: readonly string[], context: AstContext, read: () => T): T {
  for (const name of chain) context.resolving.add(name);
  try {
    return read();
  } finally {
    for (const name of chain) context.resolving.delete(name);
  }
}
