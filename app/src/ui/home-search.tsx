'use client';

import { useEffect, useRef, useState } from 'react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import type { SearchResultItem } from '../search/search-client';
import { SearchBox } from './search-box';
import { sitePath } from './site-url.mjs';
import { detailHref, isClientRoutable } from '../catalogue/detail-href';

type SearchClientModule = typeof import('../search/search-client');

export function createRetryableSearchClientLoader(importClient: () => Promise<SearchClientModule>) {
  let cached: Promise<SearchClientModule> | null = null;
  return () => {
    if (cached) return cached;
    const attempt = importClient();
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) cached = null;
    });
    return attempt;
  };
}

export function HomeSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestionError, setSuggestionError] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const searchGeneration = useRef(0);
  const warmed = useRef(false);
  const indexWarmStarted = useRef(false);
  const searchClient = useRef<(() => Promise<SearchClientModule>) | null>(null);

  const loadSearchClient = () => {
    searchClient.current ??= createRetryableSearchClientLoader(() => import('../search/search-client'));
    return searchClient.current();
  };

  const prefetchLibrary = () => {
    if (!warmed.current) {
      warmed.current = true;
      // No `sitePath`: the app router calls `addBasePath` itself (see
      // `next/dist/client/components/app-router-instance.js`), so wrapping this
      // asked for `/repo/repo/library/` on a Pages build.
      router.prefetch('/library/');
    }
    if (!indexWarmStarted.current) {
      indexWarmStarted.current = true;
      void loadSearchClient()
        .then(({ warmIndex }) => warmIndex())
        .catch(() => {});
    }
  };
  const visibleResults = query.trim() ? results : [];
  const libraryHref = sitePath(`/library/?q=${encodeURIComponent(query.trim())}`);

  const handleQueryChange = (value: string) => {
    searchGeneration.current += 1;
    setQuery(value);
    setActiveIndex(-1);
    setSuggestionError(false);
    setResults([]);
    setSuggestionsLoading(Boolean(value.trim()));
  };

  useEffect(() => {
    const value = query.trim();
    if (!value) return;
    const generation = searchGeneration.current;
    let active = true;
    void loadSearchClient()
      .then(async ({ search }) => {
        if (!active || generation !== searchGeneration.current) return;
        const response = await search(value, undefined, undefined);
        if (active && generation === searchGeneration.current) {
          setResults(response.items.slice(0, 5));
          setActiveIndex(-1);
          setSuggestionError(false);
          setSuggestionsLoading(false);
        }
      })
      .catch(() => {
        if (active && generation === searchGeneration.current) {
          setResults([]);
          setSuggestionError(true);
          setSuggestionsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [query, searchRevision]);

  const retrySuggestions = () => {
    if (!query.trim()) return;
    searchGeneration.current += 1;
    setSuggestionError(false);
    setResults([]);
    setSuggestionsLoading(true);
    setSearchRevision((current) => current + 1);
  };
  const isSuggestionsLoading = Boolean(query.trim()) && suggestionsLoading;

  return (
    <div onFocusCapture={prefetchLibrary} className="relative">
      <SearchBox
        value={query}
        onChange={handleQueryChange}
        isHomepage
        placeholder="Search workflows by task, integration, or trigger"
        onSubmit={(value) => router.push(`/library/?q=${encodeURIComponent(value)}` as Route)}
        resultCount={visibleResults.length}
        activeIndex={activeIndex}
        activeDescendantId={activeIndex >= 0 ? `search-result-${activeIndex}` : undefined}
        onNavigateHighlight={(direction) => {
          if (!visibleResults.length) return;
          setActiveIndex((current) => direction === 'down'
            ? (current + 1) % visibleResults.length
            : current < 0 ? visibleResults.length - 1 : (current - 1 + visibleResults.length) % visibleResults.length);
        }}
        onSelectHighlight={() => {
          const result = visibleResults[activeIndex];
          if (!result) return;
          // `router.push` applies basePath itself, so `sitePath` here produced
          // `/repo/repo/w/...` on a Pages build. A destination Next's router
          // does not own takes a document navigation, which does need sitePath.
          const href = detailHref({ id: result.id, slug: result.slug });
          if (isClientRoutable({ isPrerendered: result.isPrerendered })) {
            router.push(href as Route);
            return;
          }
          window.location.assign(sitePath(href));
        }}
      />
      {(visibleResults.length > 0 || suggestionError || isSuggestionsLoading) && (
        <div className="absolute left-0 right-0 top-[52px] z-[60] overflow-hidden rounded-control border border-hairline bg-panel">
          {isSuggestionsLoading ? (
            <div role="status" aria-live="polite" className="px-4 py-3 text-sm text-ink-muted">
              Loading suggestions…
            </div>
          ) : visibleResults.length > 0 ? (
            <>
              <div id="search-results-list" role="listbox" aria-label="Workflow suggestions">
                {visibleResults.map((result, index) => {
              // An anchor, so this one does need `sitePath`.
              const targetHref = sitePath(detailHref({ id: result.id, slug: result.slug }));
              const selected = index === activeIndex;
              return (
                <a
                  key={result.id}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={selected}
                  href={targetHref}
                  className={`flex min-h-11 flex-col justify-center border-b border-hairline px-4 py-2.5 hover:bg-raised focus-visible:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-border active:bg-raised active:text-accent-text ${selected ? 'bg-raised' : ''}`}
                >
                  <span className="block truncate text-sm font-medium text-ink">{result.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-ink-faint">{result.tags.slice(0, 3).join(' · ') || 'Workflow'}</span>
                </a>
              );
                })}
              </div>
              <a href={libraryHref} className="flex min-h-11 items-center border-t border-hairline px-4 py-3 font-mono text-xs text-accent-text hover:bg-raised focus-visible:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-border active:bg-raised active:text-accent-text">
                View all results
              </a>
            </>
          ) : (
            <div role="alert" className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-ink-muted">
              <span>Suggestions could not be loaded.</span>
              <button type="button" onClick={retrySuggestions} className="min-h-11 shrink-0 rounded-control px-3 font-mono text-xs text-accent-text hover:bg-raised focus-visible:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border active:bg-raised active:text-accent-text">
                Retry suggestions
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
