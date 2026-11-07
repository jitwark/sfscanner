import type { SearchEngine } from './worker';

export type FallbackInput = {
  indexJson: string;
  facets?: unknown;
  semanticIndexJson?: string;
  /**
   * AUDIT-SEARCH-004: the extended tier delivered before a Worker crash, kept
   * around by the caller so recovery doesn't lose it. Already schema- and
   * hash-verified at delivery time — applying it here is not a second fetch,
   * just re-attaching bytes the session already accepted.
   */
  extendedIndexJson?: string;
  /** False once the client has been reset; a late import is then discarded. */
  isCurrent: () => boolean;
};

/**
 * Runs the search engine in this thread, for browsers or environments without
 * a Worker — and as the recovery path when a Worker dies mid-session.
 *
 * The import is dynamic on purpose: MiniSearch is the single largest dependency
 * in the search stack, and the normal path never loads it into the page bundle
 * because the Worker has its own. Pulling it in statically here would put it on
 * every route that imports the search client, for a path most visitors never
 * take.
 */
export async function createFallbackEngine(input: FallbackInput): Promise<SearchEngine | null> {
  const { SearchEngine: Engine } = await import('./worker');
  if (!input.isCurrent()) return null;
  const engine = new Engine();
  engine.init(input.indexJson, input.facets as never, input.semanticIndexJson);
  if (input.extendedIndexJson) engine.loadExtendedIndex(input.extendedIndexJson);
  return engine;
}
