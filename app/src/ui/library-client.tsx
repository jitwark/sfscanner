'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { getLoadedSearchReleaseIdentity, onProgress, onRankingImproved, search, warmIndex, type FacetCounts, type SearchFilters } from '../search/search-client';
import { classifySearchError, formatSearchReleaseIdentity, sameSearchReleaseIdentity, type SearchReleaseIdentity } from '../search/fetch-index';
import { createDefaultQueryState, readQueryState, subscribeQueryState, writeQueryState, type QueryState } from '../search/query-state';
import { LibraryResults, type LibraryItem } from './library-results';
import { LibraryLoadMore } from './library-load-more';
import { SearchBox } from './search-box';
import { detailHref, isClientRoutable } from '../catalogue/detail-href';
import { sitePath } from './site-url.mjs';
import { ActiveFilters, activeFilterLabels } from './active-filters';
import { QuickFilterRow } from './quick-filter-row';
import type { LibrarySearchFailureKind } from './library-search-error';
import { EMPTY_FILTERS, filtersFromState, PAGE_SIZE, toLibraryItemFromSearch, type LibraryClientProps, type Progress } from './library-client-model';
const FacetSheet = dynamic(() => import('./facet-sheet').then((module) => module.FacetSheet), { ssr: false });
const LibrarySearchError = dynamic(() => import('./library-search-error').then((module) => module.LibrarySearchError), { ssr: false });
const FacetsNotice = dynamic(() => import('./facets-notice').then((module) => module.FacetsNotice), { ssr: false }); // lazy: `/library/` has the tightest first-load budget and a facets failure is the exception
const LibraryAlternatives = dynamic(() => import('./library-alternatives').then((module) => module.LibraryAlternatives), { ssr: false });
const getQueryStateSnapshot = () => JSON.stringify(readQueryState());
const getServerQueryStateSnapshot = () => JSON.stringify(createDefaultQueryState());
export function LibraryClient({ initialItems, initialCounts, totalCount, initialReleaseIdentity }: LibraryClientProps) {
  const router = useRouter();
  const querySnapshot = useSyncExternalStore(subscribeQueryState, getQueryStateSnapshot, getServerQueryStateSnapshot);
  const initialState = useMemo(() => JSON.parse(querySnapshot) as QueryState, [querySnapshot]);
  const filterSnapshot = JSON.stringify(filtersFromState(initialState));
  const filters = useMemo(() => JSON.parse(filterSnapshot) as SearchFilters, [filterSnapshot]);
  const query = initialState.q;
  const sort = initialState.sort;
  const hasInitialQuery = Boolean(initialState.q || initialState.trigger.length || initialState.capability.length || initialState.complexity || initialState.grade || initialState.rights || initialState.integration.length || initialState.tag.length);
  const needsSavedStateValidation = totalCount > 0 && (hasInitialQuery || initialState.sort !== 'relevance');
  const validationKey = JSON.stringify({ ...initialState, page: 1 });
  const [savedStateValidation, setSavedStateValidation] = useState<{ key: string; status: 'valid' | 'stale' } | null>(null);
  const savedStateStatus = !needsSavedStateValidation
    ? 'valid'
    : savedStateValidation?.key === validationKey ? savedStateValidation.status : 'checking';
  const [items, setItems] = useState(initialItems);
  const [counts, setCounts] = useState<FacetCounts>(initialCounts);
  const [total, setTotal] = useState(totalCount);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [progress, setProgress] = useState<Progress>({ loaded: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const page = initialState.page;
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<LibrarySearchFailureKind | null>(null);
  const [releaseIdentity, setReleaseIdentity] = useState(initialReleaseIdentity ? formatSearchReleaseIdentity(initialReleaseIdentity) : 'manifest-v1 · unavailable');
  const [historyRevision, setHistoryRevision] = useState(0);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const retryRequest = useRef({ page: 1, mode: 'replace' as 'replace' | 'append' });
  const initialPage = useRef(1);
  const focusedItem = useRef<LibraryItem | null>(null);
  const refreshSequence = useRef(0);
  const refreshAbort = useRef<AbortController | null>(null);
  const pageRef = useRef(1);
  useEffect(() => { pageRef.current = page; focusedItem.current = activeIndex >= 0 ? items[activeIndex] ?? null : null; }, [activeIndex, items, page]);
  useEffect(() => { initialPage.current = page; }, [page]);
  const refresh = useCallback(async (
    nextQuery: string,
    nextFilters: SearchFilters,
    targetPage = 1,
    mode: 'replace' | 'append' = 'replace', preserveActive = false, nextSort = 'relevance',
  ) => {
    const requestPage = mode === 'replace' ? 1 : targetPage;
    const limit = mode === 'replace' ? targetPage * PAGE_SIZE : PAGE_SIZE;
    const requestId = ++refreshSequence.current; refreshAbort.current?.abort(); const controller = new AbortController(); refreshAbort.current = controller;
    if (mode === 'append') setLoadingMore(true);
    setSearchError(null);
    try {
      const result = await search(nextQuery, nextFilters, { sort: nextSort, page: requestPage, limit }, controller.signal);
      if (requestId !== refreshSequence.current) return;
      const loadedIdentity = getLoadedSearchReleaseIdentity?.();
      if (initialReleaseIdentity && loadedIdentity && !sameSearchReleaseIdentity(initialReleaseIdentity, loadedIdentity)) {
        setItems([]); setTotal(0); setSearchError('stale-release');
        setReleaseIdentity(formatSearchReleaseIdentity(loadedIdentity)); retryRequest.current = { page: targetPage, mode }; return;
      }
      const nextItems = result.items.map(toLibraryItemFromSearch);
      const preservedItem = preserveActive ? focusedItem.current : null;
      const visibleItems = preservedItem && !nextItems.some((entry) => entry.id === preservedItem.id) ? [...nextItems, preservedItem] : nextItems;
      setItems((current) => {
        if (mode === 'replace') return visibleItems;
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...nextItems.filter((entry) => !seen.has(entry.id))];
      });
      setCounts(result.counts);
      setTotal(result.total);
      writeQueryState({ page: targetPage }, 'replace');
      if (preserveActive && preservedItem) setActiveIndex(visibleItems.findIndex((entry) => entry.id === preservedItem.id));
      else if (targetPage === 1) setActiveIndex(-1);
    } catch (error) {
      if (requestId !== refreshSequence.current || controller.signal.aborted) return;
      if (mode === 'replace') setItems([]);
      const typedError = error as { releaseIdentity?: SearchReleaseIdentity };
      if (typedError.releaseIdentity) setReleaseIdentity(formatSearchReleaseIdentity(typedError.releaseIdentity)); setSearchError(classifySearchError(error));
      retryRequest.current = { page: targetPage, mode };
      void import('../catalogue/manifest').then(({ loadManifest }) => loadManifest())
        .then((manifest) => setReleaseIdentity(`${manifest.schemaVersion} · ${manifest.generatedAt}`))
        .catch(() => setReleaseIdentity('manifest-v1 · unavailable'));
    } finally {
      if (refreshAbort.current === controller) refreshAbort.current = null;
      if (requestId === refreshSequence.current) setLoadingMore(false);
    }
  }, [initialReleaseIdentity]);
  useEffect(() => {
    const stop = onProgress((loaded, totalBytes) => setProgress({ loaded, total: totalBytes }));
    const idle = window.requestIdleCallback?.(() => void warmIndex()) ?? window.setTimeout(() => void warmIndex(), 1);
    const markReady = window.setTimeout(() => setReady(true), 0);
    return () => { if (typeof stop === 'function') stop(); refreshAbort.current?.abort(); if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number); else window.clearTimeout(idle); window.clearTimeout(markReady); };
  }, []);
  useEffect(() => {
    if (!needsSavedStateValidation) return;
    if (savedStateValidation?.key === validationKey) return;
    let active = true;
    void import('../search/query-state-catalogue').then(({ hasUnsupportedLibraryState, validateLibraryQueryState }) => {
      if (!active) return;
      const stale = hasUnsupportedLibraryState(validateLibraryQueryState(initialState, initialCounts));
      setSavedStateValidation({ key: validationKey, status: stale ? 'stale' : 'valid' });
      if (stale) { setItems([]); setTotal(0); }
    }).catch(() => {
      if (active) { setSavedStateValidation({ key: validationKey, status: 'stale' }); setItems([]); setTotal(0); }
    });
    return () => { active = false; };
  }, [initialCounts, initialState, needsSavedStateValidation, savedStateValidation, validationKey]);
  useEffect(() => {
    if (!ready || savedStateStatus !== 'valid') return;
    const refreshTimer = window.setTimeout(() => { const targetPage = initialPage.current; initialPage.current = 1; void refresh(query, filters, targetPage, 'replace', false, sort); }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [filters, historyRevision, query, ready, refresh, sort, savedStateStatus]);
  useEffect(() => onRankingImproved(() => { void refresh(query, filters, pageRef.current, 'replace', true, sort); }), [filters, query, refresh, sort]);
  useEffect(() => {
    const restore = () => {
      const state = readQueryState();
      initialPage.current = state.page;
      setHistoryRevision((revision) => revision + 1);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const clearResultsForQueryChange = () => { setItems([]); setTotal(0); setSearchError(null); setActiveIndex(-1); focusedItem.current = null; };
  const updateQuery = (value: string) => { clearResultsForQueryChange(); writeQueryState({ ...readQueryState(), q: value }, 'replace'); };
  const updateFilters = (next: SearchFilters) => {
    clearResultsForQueryChange();
    const trigger = Array.isArray(next.trigger) ? next.trigger : next.trigger ? [next.trigger] : [];
    writeQueryState({ ...readQueryState(), ...next, trigger, capability: next.capability ?? [] }, 'push');
  };
  const updateSort = (value: string) => { clearResultsForQueryChange(); writeQueryState({ sort: value }, 'push'); };
  const resetSavedState = () => { setSearchError(null); clearResultsForQueryChange(); writeQueryState({ q: '', integration: [], tag: [], trigger: [], capability: [], complexity: '', grade: '', rights: '', sort: 'relevance', page: 1 }, 'replace'); };
  const select = (index: number) => {
    setActiveIndex(index);
    const item = items[index];
    if (!item) return;
    if (isClientRoutable(item)) {
      router.push(detailHref(item) as Route);
      return;
    }
    window.location.assign(sitePath(detailHref(item)));
  };
  const navigateHighlight = (direction: 'up' | 'down') => setActiveIndex((current) => { const next = Math.max(0, Math.min(items.length - 1, current + (direction === 'down' ? 1 : -1))); focusedItem.current = items[next] ?? null; return next; });
  const activeFilterCount = activeFilterLabels(filters).length;
  const currentSearchError = savedStateStatus === 'stale' ? 'stale-state' : searchError === 'stale-state' ? null : searchError;
  const visibleTotal = savedStateStatus === 'checking' ? 0 : total;
  const loading = progress.total > 0 && progress.loaded < progress.total; const percent = progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  return (
    <div className="space-y-5">
      <SearchBox value={query} onChange={updateQuery} onFocus={() => void warmIndex()} resultCount={visibleTotal} resultsRendered={savedStateStatus !== 'checking' && !currentSearchError && items.length > 0} activeIndex={activeIndex} activeDescendantId={activeIndex >= 0 ? `result-${items[activeIndex]?.id}` : undefined} onNavigateHighlight={navigateHighlight} onSelectHighlight={() => select(activeIndex)} />
      <QuickFilterRow counts={counts} filters={filters} sort={sort} onFilterChange={updateFilters} onSortChange={updateSort} onMoreFilters={() => setSheetOpen(true)} />
      <ActiveFilters filters={filters} onFilterChange={updateFilters} /><FacetsNotice />
      {loading && <div aria-label={`Loading search index: ${percent}%`} className="space-y-1"><div className="h-1 overflow-hidden rounded-full bg-raised"><div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} /></div><p className="font-mono text-xs text-ink-faint">Searching {totalCount.toLocaleString()} workflows · {percent}%</p></div>}
      <div className="flex items-center justify-between gap-3"><button ref={filterTriggerRef} type="button" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} className="h-11 rounded-control border border-hairline px-3 text-sm text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised aria-expanded:border-accent-border aria-expanded:text-accent-text">{activeFilterCount ? `Filters (${activeFilterCount}: ${activeFilterLabels(filters).join(', ')})` : 'Filters'}</button><span className="font-mono text-xs text-ink-muted">{visibleTotal.toLocaleString()} workflows</span></div>
      {sheetOpen && <FacetSheet open counts={counts} filters={filters} onApply={updateFilters} onClose={() => { setSheetOpen(false); filterTriggerRef.current?.focus(); }} />}
      <div className="min-w-0">
        <section aria-labelledby="library-results-heading" className="min-w-0">
          <h2 id="library-results-heading" className="sr-only">Workflow results</h2>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline pb-2">
            <p aria-live="polite" className="font-mono text-xs tabular-nums text-ink">
              {savedStateStatus === 'checking' ? (
                <span className="text-ink-muted">Searching workflows...</span>
              ) : (
                <><strong className="font-semibold">{visibleTotal.toLocaleString()}</strong> <span className="text-ink-muted">{visibleTotal === 1 ? 'workflow' : 'workflows'}</span>{visibleTotal < totalCount && <span className="text-ink-faint"> of {totalCount.toLocaleString()}</span>}</>
              )}
            </p>
            <p className="font-mono text-2xs text-ink-faint">Ranked by {sort}</p>
          </div>
          {currentSearchError && <LibrarySearchError kind={currentSearchError} releaseIdentity={releaseIdentity} onRetry={() => currentSearchError === 'stale-release' || currentSearchError === 'schema' ? window.location.reload() : currentSearchError === 'stale-state' ? resetSavedState() : void refresh(query, filters, retryRequest.current.page, retryRequest.current.mode, false, sort)} />}
          {savedStateStatus === 'checking' ? (
            <LibraryResults items={[]} activeIndex={-1} loading={true} />
          ) : !currentSearchError && total === 0 ? (
            <div className="rounded-panel border border-hairline bg-panel p-6 text-sm text-ink-muted">
              <p className="text-ink">No workflows match{query ? ` “${query}”` : ' these filters'}.</p>
              {query && <LibraryAlternatives key={query} query={query} onSelect={updateQuery} />}
              {activeFilterCount > 0 && <button type="button" onClick={() => updateFilters(EMPTY_FILTERS)} className="mt-2 block min-h-11 rounded-control px-2 text-accent-text transition-colors hover:bg-raised hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised">Try the same search with relaxed filters</button>}
            </div>
          ) : (
            <>
              <LibraryResults items={items} activeIndex={activeIndex} loading={!ready} />
              {items.length > 0 && <LibraryLoadMore loaded={items.length} total={total} busy={loadingMore} onLoadMore={() => void refresh(query, filters, page + 1, 'append', false, sort)} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
