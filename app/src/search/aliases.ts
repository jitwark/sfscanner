import { SEARCH_ALIASES, aliasesFor } from '@hub/contracts';

export const ALIASES = SEARCH_ALIASES;
/** Own-property lookup; see the note on SEARCH_ALIASES in contracts. */
export const aliasesOf = aliasesFor;

export type ExpansionResult = {
  expandedQuery: string;
  expandedTerms: Record<string, string[]>;
};

export function expandQueryDetails(query: string): ExpansionResult {
  if (!query.trim()) return { expandedQuery: '', expandedTerms: {} };

  const tokens = query.match(/"[^"]*"|\S+/g) || [];
  const resultTokens: string[] = [];
  const seenTerms = new Set<string>();
  const expandedTerms: Record<string, string[]> = {};

  for (const token of tokens) {
    if (token.startsWith('"') && token.endsWith('"')) {
      resultTokens.push(token);
      continue;
    }

    const term = token.toLowerCase();
    if (!seenTerms.has(term)) {
      seenTerms.add(term);
      resultTokens.push(token);
    }

    const aliases = aliasesFor(term);
    const added = aliases.filter((alias) => {
      if (seenTerms.has(alias)) return false;
      seenTerms.add(alias);
      resultTokens.push(alias);
      return true;
    });
    if (added.length > 0) expandedTerms[term] = added;
  }

  return { expandedQuery: resultTokens.join(' '), expandedTerms };
}

export function expandQuery(query: string): string {
  return expandQueryDetails(query).expandedQuery;
}
