import { gzipSync } from 'node:zlib';
import { buildSemanticVector, SEMANTIC_DIMENSIONS, type Entry, type SemanticIndex } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { buildSearchText } from './search-text';

export type SemanticIndexResult = {
  serializedIndex: string;
  stats: { uncompressedBytes: number; compressedBytes: number };
};

export function buildSemanticIndex(entries: Entry[]): SemanticIndexResult {
  const index: SemanticIndex = {
    version: 1,
    dimensions: SEMANTIC_DIMENSIONS,
    // Empty by design. Ordinals ship with the facet bitsets they index, which
    // is what lets this file be fetched lazily; and this index now covers only
    // the primary tier, so an ordinal list built from it would be a partial
    // one that silently mis-addresses every bitset. The worker still reads this
    // field as a fallback for an older packaged corpus.
    ordinals: [],
    documents: entries
      .filter((entry) => entry.descriptionSource === 'generated' && entry.dedup?.canonical === true)
      .sort((left, right) => compareCanonicalStrings(left.id, right.id))
      .map((entry) => ({ id: entry.id, vector: buildSemanticVector(buildSearchText(entry)) })),
  };
  const serializedIndex = JSON.stringify(index);
  const bytes = Buffer.from(serializedIndex, 'utf8');
  return {
    serializedIndex,
    stats: { uncompressedBytes: bytes.byteLength, compressedBytes: gzipSync(bytes).byteLength },
  };
}
