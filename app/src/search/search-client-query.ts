import type { FacetCounts } from './facet-bitset';
import type { SearchDisplayItem, SearchEngine, SearchFilters } from './worker';

export type SearchResultItem = SearchDisplayItem;
export type SearchResponseData = { ids: string[]; total: number; counts: FacetCounts; items: SearchResultItem[] };
type SearchOptions = { sort?: string; page?: number; limit?: number };
type Pending = { resolve: (result: SearchResponseData) => void; reject: (error: Error) => void; signal?: AbortSignal };
type Queued = Pending & { query: string; filters?: SearchFilters; options?: SearchOptions };

type WorkerMessage = {
  type: string;
  id?: number;
  ids?: string[];
  items?: SearchResultItem[];
  total?: number;
  counts?: FacetCounts;
  error?: unknown;
  message?: string;
};

export type SearchQueryDependencies = {
  getWorker: () => Worker | null;
  getFallbackEngine: () => SearchEngine | null;
  isReady: () => boolean;
  startWarm: () => Promise<void>;
  isCurrentWarm: (promise: Promise<void>) => boolean;
  requestExtendedTier: () => void;
  requestSemanticVectorsFor: (query: string) => void;
  cacheItems: (items: SearchResultItem[]) => void;
  onWorkerFailure: (cause: unknown, worker: Worker) => void;
  onWorkerReady: () => void;
  reportRankingImproved: () => void;
  onFacetsApplied: () => void;
};

const emptyCounts = (): FacetCounts => ({ rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} });
const superseded = () => new Error('Search request superseded');

export function createSearchQueryController(dependencies: SearchQueryDependencies) {
  let nextQueryId = 0;
  const pending = new Map<number, Pending>();
  let queued: Queued | null = null;
  let debouncedReject: ((error: Error) => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function settleQueued(): void {
    if (!queued || !dependencies.isReady()) return;
    const request = queued;
    queued = null;
    searchImmediate(request.query, request.filters, request.options, request.signal).then(request.resolve, request.reject);
  }

  function searchImmediate(query: string, filters?: SearchFilters, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponseData> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const id = ++nextQueryId;
      for (const [oldId, old] of pending) { pending.delete(oldId); old.reject(superseded()); }
      const request: Pending = { resolve, reject, signal };
      pending.set(id, request);
      dependencies.requestExtendedTier();
      dependencies.requestSemanticVectorsFor(query);
      const abort = () => { if (pending.get(id) === request) { pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); } };
      signal?.addEventListener('abort', abort, { once: true });
      const worker = dependencies.getWorker();
      if (worker) {
        try { worker.postMessage({ type: 'search', id, query, filters, options }); }
        catch (error) { dependencies.onWorkerFailure(error, worker); }
      } else {
        const engine = dependencies.getFallbackEngine();
        if (!engine) { pending.delete(id); reject(new Error('Search engine uninitialized')); return; }
        const response = engine.search(id, query, filters, options);
        if (!response) { pending.delete(id); reject(superseded()); return; }
        dependencies.cacheItems(response.items);
        pending.delete(id);
        resolve({ ids: response.ids, items: response.items, total: response.total, counts: response.counts });
      }
    });
  }

  function search(query: string, filters?: SearchFilters, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponseData> {
    return new Promise((resolve, reject) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (queued) { queued.reject(superseded()); queued = null; }
      if (debouncedReject) debouncedReject(superseded());
      debouncedReject = reject;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        debouncedReject = null;
        if (!dependencies.isReady()) {
          queued = { query, filters, options, resolve, reject, signal };
          const warm = dependencies.startWarm();
          warm.catch((error) => {
            if (dependencies.isCurrentWarm(warm) && queued) {
              queued.reject(error instanceof Error ? error : new Error(String(error)));
              queued = null;
            }
          });
        } else searchImmediate(query, filters, options, signal).then(resolve, reject);
      }, 120);
    });
  }

  function handleWorkerMessage(message: WorkerMessage, sourceWorker?: Worker): void {
    if (sourceWorker && dependencies.getWorker() !== sourceWorker) return;
    if (message.type === 'error' || message.type === 'workerError') {
      dependencies.onWorkerFailure(message.error ?? message.message, sourceWorker!); return;
    }
    if (message.type === 'semanticReady' || message.type === 'extendedReady') {
      dependencies.reportRankingImproved(); return;
    }
    if (message.type === 'facetsReady') {
      dependencies.onFacetsApplied(); return;
    }
    if (message.type === 'ready') {
      dependencies.onWorkerReady(); settleQueued(); dependencies.requestExtendedTier(); return;
    }
    if (message.type !== 'searchResult' || message.id === undefined || message.id < 0) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    const items = message.items ?? [];
    dependencies.cacheItems(items);
    request.resolve({ ids: message.ids ?? [], items, total: message.total ?? 0, counts: message.counts ?? emptyCounts() });
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function rejectQueued(error: Error): void {
    if (queued) { queued.reject(error); queued = null; }
  }

  function reset(): void {
    nextQueryId = 0;
    pending.clear();
    queued = null;
    debouncedReject = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  return { search, handleWorkerMessage, settleQueued, rejectPending, rejectQueued, reset };
}
