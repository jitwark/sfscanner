import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getHubIndex } from '../../../src/catalogue/hub-index';
import { entriesForHub, publishedHubsForKind } from '../../../src/catalogue/hub-route';
import { hubMeta } from '../../../src/seo/page-meta';
import { HubPage } from '../../../src/ui/hub-page';

export const dynamicParams = false;

type Params = Promise<{ slug: string }>;

export function generateStaticParams() {
  return publishedHubsForKind(getHubIndex(), 'trigger').map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const hub = getHubIndex().triggers[slug] ?? notFound();
  return hubMeta('trigger', slug, 1, hub.totalEntries);
}

export default async function TriggerPage({ params }: { params: Params }) {
  const { slug } = await params;
  const hub = getHubIndex().triggers[slug] ?? notFound();
  return (
    <HubPage
      kind="trigger"
      hub={hub}
      entries={entriesForHub(hub, 1)}
      basePath={`/triggers/${slug}/`}
      page={1}
    />
  );
}
