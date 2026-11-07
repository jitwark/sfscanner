import type { SearchIndexFailureKind } from '../search/fetch-index';

type LibrarySearchErrorProps = {
  releaseIdentity: string;
  onRetry: () => void;
  kind: LibrarySearchFailureKind;
};
export type LibrarySearchFailureKind = SearchIndexFailureKind | 'stale-state';

const FAILURE_COPY: Record<LibrarySearchFailureKind, string> = {
  unavailable: 'Search data unavailable. Check your connection.',
  http: 'Search download failed.',
  malformed: 'Invalid search data.',
  schema: 'This release has incompatible search metadata.',
  'stale-release': 'This page and its search data belong to different releases.',
  'stale-state': 'Saved filters or sorting are not present in this release.',
};

export function LibrarySearchError({ kind, releaseIdentity, onRetry }: LibrarySearchErrorProps) {
  return (
    <div role="alert" className="mb-4 rounded-panel border border-hairline bg-panel p-4 text-sm text-ink">
      <p className="font-medium">{kind === 'stale-state' ? 'Saved library state needs attention.' : 'Search index unavailable.'}</p>
      <p className="mt-1 text-ink-muted">{FAILURE_COPY[kind]} {kind === 'stale-state' ? 'Reset to continue.' : 'Retry.'}</p>
      <p className="mt-2 font-mono text-xs text-ink-muted">Release: {releaseIdentity}</p>
      <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-control border border-hairline px-3 text-sm text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised">
        {kind === 'stale-release' || kind === 'schema' ? 'Refresh library' : kind === 'stale-state' ? 'Reset saved filters' : 'Retry search'}
      </button>
    </div>
  );
}
