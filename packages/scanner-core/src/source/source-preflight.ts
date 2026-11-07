/**
 * Finds JSON container depth without building an AST. Strings and escapes are
 * skipped so attacker-controlled brackets inside string values do not charge.
 */
export const MAX_SOURCE_PARSER_DEPTH = 512;

export function exceedsJsonDocumentDepth(text: string, maximum: number): boolean {
  let depth = 0;
  let sawValue = false;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      sawValue = true;
    } else if (character === '{' || character === '[') {
      sawValue = true;
      depth += 1;
      if (depth > maximum) return true;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (!/\s/.test(character) && character !== ',' && character !== ':') {
      sawValue = true;
    }
  }
  return sawValue && maximum < 1;
}
