import type { HubIndex } from '../catalogue/hub-types';
import type { FacetCounts } from '../search/facet-bitset';
import { BrowseByIntent } from './browse-by-intent';
import { buildIntentCatalog } from './intent-catalog';

type HomeHubLinksProps = { index: HubIndex; counts: FacetCounts };

export function HomeHubLinks({ index, counts }: HomeHubLinksProps) {
  return <BrowseByIntent catalog={buildIntentCatalog(index, counts)} />;
}
