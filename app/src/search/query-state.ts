import {
  normalizeDiscoveryFilterValue,
  normalizeDiscoverySlug,
  normalizeTaxonomyFilterValue,
  type TaxonomyGroup,
} from '@hub/contracts';

/**
 * Frozen query/filter URL contract (P4.1). Documented from the behavior this
 * module and its callers already have, not a new design:
 *
 * - Keys: `q`, `integration`, `tag`, `trigger`, `capability` (multi-value, one
 *   repeated `?key=a&key=b` param per value, order-preserving); `complexity`,
 *   `grade`, `rights`, `sort` (scalar); `page` (1-based, reset to 1 whenever
 *   any `criteria` key changes — see `sameCriterion`).
 * - Cross-facet semantics: OR within one facet group, AND across groups —
 *   enforced in `app/src/search/worker.ts` (`addGroup`/`intersectUint32Arrays`),
 *   pinned by `worker.test.ts`'s "matches an oracle with OR within groups and
 *   AND across explicit groups".
 * - History: `writeQueryState(state, 'replace' | 'push')` — callers choose;
 *   `library-client.tsx` replaces while the query text is still being typed
 *   and pushes on a discrete filter/facet change.
 * - Unicode and special characters round-trip through `URLSearchParams`
 *   unmangled for `q`; facet values are slugified by `normalizeDiscoverySlug`/
 *   `normalizeTaxonomyFilterValue`, so two different raw strings that slugify
 *   to the same value are indistinguishable by design — that is the tag/
 *   taxonomy slug space, not a bug in this module.
 * - Base path: this module only ever reads/writes `URLSearchParams` on the
 *   current `URL`, never the pathname, so a GitHub Pages base-path prefix
 *   (`NEXT_PUBLIC_BASE_PATH`) survives untouched by construction.
 * - Malformed `page` (negative, non-integer, non-numeric) falls back to `1`
 *   rather than coercing to the nearest valid page.
 * - This parser preserves saved/bookmarked facet and sort values, including
 *   values no longer present in the current release. `LibraryClient` validates
 *   those values after hydration and presents stale-state recovery; parsing
 *   alone does not silently turn unsupported filters into a valid empty result.
 */

export type QueryState = {
  q: string;
  integration: string[];
  tag: string[];
  trigger: string[];
  capability: string[];
  complexity: string;
  grade: string;
  rights: string;
  sort: string;
  page: number;
};

const defaults: QueryState = {
  q: '', integration: [], tag: [], trigger: [], capability: [],
  complexity: '', grade: '', rights: '', sort: 'relevance', page: 1,
};
const repeatable = ['integration', 'tag', 'trigger', 'capability'] as const;
const scalar = ['q', 'complexity', 'grade', 'rights', 'sort'] as const;
const criteria = ['q', 'integration', 'tag', 'trigger', 'capability', 'complexity', 'grade', 'rights'] as const;

export function createDefaultQueryState(): QueryState {
  return { ...defaults, integration: [], tag: [], trigger: [], capability: [] };
}

function sourceUrl(source?: string | URL): URL {
  if (source instanceof URL) return new URL(source.href);
  if (typeof source === 'string') return new URL(source, 'https://community-hub.invalid');
  if (typeof window !== 'undefined') return new URL(window.location.href);
  return new URL('https://community-hub.invalid/');
}

function normalizeMany(key: typeof repeatable[number], values: string[]): string[] {
  const normalized = values.filter((value) => value.trim()).map((value) => {
    if (key === 'trigger') return stateTaxonomyValue('trigger', value);
    if (key === 'capability') return stateTaxonomyValue('capability', value);
    return normalizeDiscoveryFilterValue(value) ?? normalizeDiscoverySlug(value);
  });
  return [...new Set(normalized)];
}

function stateTaxonomyValue(group: TaxonomyGroup, value: unknown): string {
  return normalizeTaxonomyFilterValue(group, value) ?? normalizeDiscoverySlug(value);
}

export function readQueryState(source?: string | URL): QueryState {
  const params = sourceUrl(source).searchParams;
  const state: QueryState = {
    ...createDefaultQueryState(),
    integration: normalizeMany('integration', params.getAll('integration')),
    tag: normalizeMany('tag', params.getAll('tag')),
    trigger: normalizeMany('trigger', params.getAll('trigger')),
    capability: normalizeMany('capability', params.getAll('capability')),
  };
  state.q = params.get('q')?.trim() ?? '';
  state.complexity = params.has('complexity') ? stateTaxonomyValue('complexity', params.get('complexity')) : '';
  state.grade = params.has('grade') ? stateTaxonomyValue('security', params.get('grade')) : '';
  state.rights = params.has('rights') ? stateTaxonomyValue('rights', params.get('rights')) : '';
  state.sort = params.get('sort') || defaults.sort;
  const page = Number(params.get('page'));
  state.page = Number.isInteger(page) && page > 0 ? page : 1;
  return state;
}

function sameCriterion(left: QueryState, right: QueryState, key: typeof criteria[number]): boolean {
  return Array.isArray(left[key])
    ? JSON.stringify(left[key]) === JSON.stringify(right[key])
    : left[key] === right[key];
}

export function writeQueryState(state: Partial<QueryState> | QueryState, mode: 'replace' | 'push'): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const current = readQueryState(url);
  const next: QueryState = {
    ...current,
    ...state,
    ...Object.fromEntries(repeatable.map((key) => [key, normalizeMany(key, state[key] ?? current[key])])),
  };
  if (criteria.some((key) => !sameCriterion(current, next, key))) next.page = 1;
  for (const key of [...scalar, ...repeatable, 'page']) url.searchParams.delete(key);
  if (next.q) url.searchParams.set('q', next.q);
  if (next.complexity) url.searchParams.set('complexity', stateTaxonomyValue('complexity', next.complexity));
  if (next.grade) url.searchParams.set('grade', stateTaxonomyValue('security', next.grade));
  if (next.rights) url.searchParams.set('rights', stateTaxonomyValue('rights', next.rights));
  if (next.sort) url.searchParams.set('sort', next.sort);
  for (const key of repeatable) for (const value of next[key]) url.searchParams.append(key, value);
  if (next.page > 1) url.searchParams.set('page', String(next.page));
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  notifyQueryStateChange();
}

type StateListener = (state: QueryState) => void;
const listeners = new Set<StateListener>();
export function onQueryStateChange(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyQueryStateChange(): void {
  const state = readQueryState();
  for (const listener of listeners) listener(state);
}

/** Subscribe to browser URL updates, including History API writes made here. */
export function subscribeQueryState(listener: () => void): () => void {
  const notify = () => listener();
  return onQueryStateChange(notify);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notifyQueryStateChange);
}
