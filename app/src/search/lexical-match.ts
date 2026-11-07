import MiniSearch, { type Query } from 'minisearch';
import { aliasesOf } from './aliases';
import type { SearchDocument } from './worker-messages-doc';

export type OrdinalMatch = { ordinal: number; bm25: number; semantic: number };

export type LexicalMatchInput = {
  tokens: string[];
  indexes: MiniSearch<SearchDocument>[];
  ordinalOf: (id: string) => number | undefined;
  semanticScores: Map<number, number>;
  /**
   * The fewest lexical candidates that can serve the window the caller asked
   * for (page × limit). The strict intersection is tried first; when it cannot
   * reach this many documents, admission relaxes one query group at a time
   * until it can. `1` therefore means "strict intersection only", which is the
   * contract for a caller that displays whatever the strict groups produce.
   */
  requiredCandidates?: number;
};

/**
 * Runs one term across every loaded tier, normalising each tier's BM25 to its
 * own maximum before merging.
 *
 * BM25 is corpus-relative: IDF depends on how many documents in *that index*
 * contain the term, so a 2,000-document tier scores the same match higher than
 * a 10,900-document one. Merging raw scores would rank by which file an entry
 * happens to live in. Normalising per tier makes the numbers comparable; the
 * caller then multiplies by `qualityScore`, which is what decided tier
 * membership in the first place.
 */
function searchEveryTier(
  indexes: MiniSearch<SearchDocument>[],
  query: Query,
): Array<{ id: string; score: number }> {
  const merged: Array<{ id: string; score: number }> = [];
  for (const index of indexes) {
    const results = index.search(query);
    const max = results.reduce((most, result) => Math.max(most, result.score), 0);
    if (max <= 0) continue;
    for (const result of results) merged.push({ id: result.id as string, score: result.score / max });
  }
  return merged;
}

function queryForToken(token: string): Query {
  const terms = (MiniSearch.getDefault('tokenize') as (value: string) => string[])(token).filter(Boolean);
  const aliases = aliasesOf(token.toLowerCase());
  if (terms.length <= 1) return { combineWith: 'OR', queries: [token, ...aliases] };

  // The outer query tokenizer keeps a whitespace-delimited group together.
  // MiniSearch then splits punctuation inside that group; require all of those
  // terms so common partial words cannot turn one compound OOV token into a
  // broad OR search. Alias expansions remain OR alternatives to the group.
  return {
    combineWith: 'OR',
    queries: [{ combineWith: 'AND', queries: terms }, ...aliases],
  };
}

/**
 * Search contract for the lexical half of a query:
 *
 * - Each whitespace-delimited token is a group. Groups admit documents by
 *   **coverage**: the strict intersection (every group) is always admitted
 *   first, then admission relaxes one group at a time — and only as far as it
 *   must to fill the caller's window. A single-group query, or any query whose
 *   strict intersection already fills the window, matches only its groups.
 * - A document's BM25 is the sum of the groups it matched, discounted by the
 *   share of the query it covers: a complete match is weighted 1 and a partial
 *   answer pays for the groups it is missing.
 * - Punctuation inside one unquoted group is ANDed. Curated aliases are OR
 *   alternatives within that group.
 * - There is no stopword list: short words such as "no", "such", and "the"
 *   remain searchable terms.
 * - Quoted groups are passed to MiniSearch as lexical-only searches. Quotes do
 *   not promise exact adjacency; the worker suppresses semantic expansion for
 *   any query containing a quoted group.
 *
 * The result contains which ordinals matched, and how strongly.
 *
 * Semantic scores are passed in rather than computed here — they come from a
 * payload that may not have arrived yet, and this layer should not know that.
 */
export function matchTokens({
  tokens,
  indexes,
  ordinalOf,
  semanticScores,
  requiredCandidates = 1,
}: LexicalMatchInput): OrdinalMatch[] {
  const matched: OrdinalMatch[] = [];
  const termSets = tokens.map((token) => {
    const quoted = token.startsWith('"') && token.endsWith('"');
    return searchEveryTier(indexes, quoted ? token : queryForToken(token));
  });

  const docScore = new Map<string, number>();
  const docCount = new Map<string, number>();
  for (const results of termSets) {
    const seen = new Set<string>();
    for (const result of results) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      docCount.set(result.id, (docCount.get(result.id) || 0) + 1);
      docScore.set(result.id, (docScore.get(result.id) || 0) + result.score);
    }
  }

  const admitted = new Set<number>();
  const addMatches = (minimumCount: number) => {
    docCount.forEach((count, id) => {
      if (count < minimumCount) return;
      const ordinal = ordinalOf(id);
      if (ordinal === undefined || admitted.has(ordinal)) return;
      admitted.add(ordinal);
      // A partial answer is discounted by the share of the query it covers, so
      // the groups it is missing cost it what they are worth. A document that
      // matched every group is weighted 1 and keeps the score it always had.
      const coverageShare = count / Math.max(1, termSets.length);
      matched.push({ ordinal, bm25: (docScore.get(id) || 1.0) * coverageShare, semantic: semanticScores.get(ordinal) || 0 });
    });
  };

  // A strict intersection can be far too small to answer the query — four
  // groups over a heterogeneous catalogue intersect in single digits — and
  // every group dropped from the requirement costs one word of evidence,
  // where the slots left over would otherwise be handed to documents with no
  // query vocabulary at all. Relax only while the window is unfilled.
  let coverage = termSets.length;
  addMatches(coverage);
  while (coverage > 1 && matched.length < requiredCandidates) {
    coverage -= 1;
    addMatches(coverage);
  }

  // A 96-dimension hashed feature vector always activates two dimensions, even
  // for a token nobody has ever indexed — an unknown token still produces a
  // "similar" cosine score to whatever else happens to hash into the same
  // bucket. That is noise, not relevance. `termSets` above already ran every
  // token (plus its aliases) through MiniSearch's fuzzy/prefix matcher across
  // every tier; if not one of them found so much as a fuzzy hit anywhere in
  // the corpus, the query has no vocabulary evidence and the semantic layer
  // has nothing real to rank — so it must not be allowed to manufacture 150
  // "matches" out of hash collisions. A single real token is enough evidence
  // to keep semantic-only expansion working for genuine intent-only queries.
  const hasVocabularyEvidence = termSets.some((results) => results.length > 0);

  if (semanticScores.size > 0 && hasVocabularyEvidence) {
    const existing = new Set(matched.map((item) => item.ordinal));
    [...semanticScores.entries()]
      .sort((left, right) => right[1] - left[1])
      .filter(([, score]) => score >= 0.08)
      .slice(0, 150)
      .forEach(([ordinal, semantic]) => {
        if (!existing.has(ordinal)) matched.push({ ordinal, bm25: 0, semantic });
      });
  }
  return matched;
}
