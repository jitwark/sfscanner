import type { SearchResponse, WorkerSearchMessage } from './worker-messages';
import type { SearchEngine } from './worker';

/**
 * Keeps the message boundary on the same path as offline evaluation. The
 * direct evaluator and the browser worker must not grow separate ranking
 * implementations or silently disagree on filters, pagination, or ties.
 */
export function handleWorkerSearchMessage(engine: SearchEngine, message: WorkerSearchMessage): SearchResponse | null {
  return engine.search(message.id, message.query, message.filters, message.options);
}
