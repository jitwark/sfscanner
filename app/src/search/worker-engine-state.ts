import type MiniSearch from 'minisearch';
import type { RankedSearchDisplayItem } from './worker-messages';
import type { SearchDocument } from './worker-messages-doc';

export type SearchEngineState = {
  miniSearch: MiniSearch<SearchDocument> | null;
  rawBitsets: Record<string, Uint32Array>;
  idToOrdinal: Map<string, number>;
  ordinalToItem: Array<RankedSearchDisplayItem | undefined>;
  ordinalIds: string[];
  indexes: MiniSearch<SearchDocument>[];
  totalEntries: number;
  publishableBitset: Uint32Array<ArrayBufferLike>;
  semanticVectors: Map<string, number[]>;
  lastHandledQueryId: number;
};

export function createEngineState(): SearchEngineState {
  return {
    miniSearch: null,
    rawBitsets: {},
    idToOrdinal: new Map(),
    ordinalToItem: [],
    ordinalIds: [],
    indexes: [],
    totalEntries: 0,
    publishableBitset: new Uint32Array(0),
    semanticVectors: new Map(),
    lastHandledQueryId: -1,
  };
}
