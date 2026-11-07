'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Entry } from '@hub/contracts';
import { fetchEntryById } from '../../../src/catalogue/entry-detail-client';
import { DetailBody } from '../../../src/ui/detail/detail-body';
import { sitePath } from '../../../src/ui/site-url.mjs';

type ViewState = { entry: Entry | null; related: Entry[]; error: string | null };

function DetailSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-7xl animate-pulse flex-col gap-8 px-4 py-8 pb-16 sm:px-6 lg:px-8" aria-busy="true">
      {/* A visually hidden heading keeps the shell from being a page with no
          heading; DetailBody renders the real title once the shard resolves. */}
      <h1 className="sr-only">Loading workflow</h1>
      <div className="space-y-4"><div className="h-3 w-48 rounded bg-raised" /><div className="h-12 w-3/4 rounded bg-raised" /><div className="h-5 w-2/3 rounded bg-raised" /></div>
      <div className="grid grid-cols-2 border-y border-hairline sm:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-20 border-hairline p-4"><div className="h-3 w-16 rounded bg-raised" /><div className="mt-3 h-4 w-20 rounded bg-raised" /></div>)}</div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]"><div className="space-y-8"><div className="h-36 rounded-panel bg-panel" /><div className="h-80 rounded-panel bg-panel" /><div className="h-40 rounded-panel bg-panel" /></div><div className="h-72 rounded-panel bg-panel" /></div>
    </div>
  );
}

function Content() {
  const params = useSearchParams();
  const id = params.get('id');
  const relatedParam = params.get('related');
  return <WorkflowContent key={id ?? 'missing'} id={id} relatedParam={relatedParam} />;
}

/**
 * Related ids carried on the URL by `interactiveHref` (`detail-href.ts`) — the
 * build-time-correct `computeRelated` output for this entry, computed once
 * against the full eligible catalogue and passed along rather than
 * recomputed here (see P5.4/P1.7: this route cannot afford to fetch the
 * catalogue or the search index just to answer "what's related").
 *
 * Parsed defensively: a malformed or hand-edited URL must never resurrect the
 * entry's own id into its own "related" list.
 */
function parseRelatedIds(raw: string | null, currentId: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    if (ids.length >= 6) break;
    if (!part) continue;
    let candidate: string;
    try {
      candidate = decodeURIComponent(part);
    } catch {
      continue;
    }
    if (!candidate || candidate === currentId || seen.has(candidate)) continue;
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

/**
 * Resolves each related id through the same bounded, byte-addressed fetch as
 * the main entry — a few KB each, never a shard. A related id that fails to
 * resolve (deleted entry, transient network error) is dropped rather than
 * failing the whole page: a shorter related list beats none.
 */
async function loadRelated(ids: string[], signal: AbortSignal): Promise<Entry[]> {
  const resolved = await Promise.all(ids.map(async (relatedId) => {
    try {
      return await fetchEntryById(relatedId, signal);
    } catch {
      return null;
    }
  }));
  return resolved.filter((candidate): candidate is Entry => candidate !== null);
}

function WorkflowContent({ id, relatedParam }: { id: string | null; relatedParam: string | null }) {
  const [state, setState] = useState<ViewState>(() => ({
    entry: null,
    related: [],
    error: id ? null : 'This view needs a workflow id.',
  }));

  useEffect(() => {
    if (!id) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const entry = await fetchEntryById(id, controller.signal);
        if (!entry) throw new Error('Workflow not found.');
        const related = await loadRelated(parseRelatedIds(relatedParam, id), controller.signal);
        if (active) setState({ entry, related, error: null });
      } catch (cause) {
        if (active) setState({ entry: null, related: [], error: cause instanceof Error ? cause.message : 'Unable to load workflow.' });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [id, relatedParam]);

  if (!state.entry) return state.error ? (
    // Not a <main>: the root layout (`app/layout.tsx`) already renders
    // `<main id="main">` around this route's children, so a second one here
    // was a nested-landmark bug (P3.1) — the shell owns the one `<main>`.
    <div className="mx-auto max-w-3xl px-4 py-16 text-center text-ink-muted" role="status">
      <h1 className="font-display text-3xl font-semibold text-ink">Workflow not found</h1>
      <p className="mt-3">{state.error}</p>
      <a href={sitePath('/library/')} className="mt-6 inline-flex rounded-control bg-accent px-4 py-2 font-mono text-sm font-semibold text-page">Back to library</a>
    </div>
  ) : <DetailSkeleton />;
  // `/w/view/` is the client-only interaction surface. Preview SVGs are
  // build-time inputs embedded in the catalogue detail pages and are removed
  // from the final export after those pages are generated; this route must
  // not make a speculative preview request before the explicit canvas action.
  //
  // That explicit action belongs to `ChartLoader`, and `ChartLoader` is the
  // `default` layout's canvas. The `workbench` layout's canvas is
  // `CompactVectorDiagram`, which draws a build-time preview this route does
  // not have — so on this route it could only ever reach its preview-unavailable
  // branch, and it does so in an un-roled `div` rather than `ChartLoader`'s
  // `role="status"` panel. `bd38085` introduced the workbench as an opt-in for
  // the pre-rendered tier (which always supplies a preview via `readPreviewSync`)
  // and left this route on `default`; `a1681ad` moved it here incidentally, which
  // is the state this restores from. `?layout=workbench` still selects the
  // workbench on request — only the interactive default changed back.
  return <DetailBody entry={state.entry} related={state.related} initialLayout="default" />;
}

export function WorkflowViewClient() {
  return <Suspense fallback={<DetailSkeleton />}><Content /></Suspense>;
}
