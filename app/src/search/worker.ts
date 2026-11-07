import { SearchEngine } from './worker-engine';
import { handleWorkerSearchMessage } from './worker-message-handler';
import type { WorkerMessage } from './worker-messages';

export { SearchEngine } from './worker-engine';
export { qualityScore } from '@hub/contracts';
export type { SearchDisplayItem } from '@hub/contracts';
export type { SearchDocument } from './worker-messages-doc';
export type {
  RankedSearchDisplayItem,
  SearchFilters,
  SearchResponse,
  WorkerSearchMessage,
  WorkerFacetsData,
  WorkerExtendedMessage,
  WorkerInitMessage,
  WorkerMessage,
  WorkerSemanticMessage,
} from './worker-messages';

const engine = new SearchEngine();

if (typeof self !== 'undefined' && typeof postMessage !== 'undefined') {
  self.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (msg.type === 'init') {
      engine.init(msg.indexJson, msg.facetsData, msg.semanticIndexJson);
      postMessage({ type: 'ready' });
    } else if (msg.type === 'extended') {
      if (engine.loadExtendedIndex(msg.indexJson)) postMessage({ type: 'extendedReady' });
    } else if (msg.type === 'semantic') {
      if (engine.loadSemanticVectors(msg.semanticIndexJson)) postMessage({ type: 'semanticReady' });
    } else if (msg.type === 'facets') {
      if (engine.applyFacets(msg.facetsData)) postMessage({ type: 'facetsReady' });
    } else if (msg.type === 'search') {
      const response = handleWorkerSearchMessage(engine, msg);
      if (response) postMessage(response);
    }
  };
}
