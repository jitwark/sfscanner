import type { SearchDisplayItem } from '@hub/contracts';

/**
 * What MiniSearch is given at build time and reads back at query time.
 *
 * It lives apart from `worker.ts` so the query layers can name it without
 * importing the engine, and apart from `worker-messages.ts` because it is not
 * part of the postMessage contract — it never crosses a thread boundary.
 */
export type SearchDocument = SearchDisplayItem & { content: string };
