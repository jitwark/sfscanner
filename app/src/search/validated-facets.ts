import { parseFacetPayload } from '@hub/contracts/facet-artifact';

/** Optional facet data must never prevent lexical search from starting. */
export function parseWorkerFacets(value: unknown) {
  if (value === undefined) return undefined;
  try { return parseFacetPayload(value); } catch { return undefined; }
}
