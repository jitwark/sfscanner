import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getHubIndex } from '../../../src/catalogue/hub-index';
import { entriesForHub, publishedHubsForKind } from '../../../src/catalogue/hub-route';
import { hubMeta } from '../../../src/seo/page-meta';
import { HubPage } from '../../../src/ui/hub-page';

export const dynamicParams = false;

type Params = Promise<{ grade: string }>;

export function generateStaticParams() {
  return publishedHubsForKind(getHubIndex(), 'security').map(({ slug }) => ({ grade: slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { grade } = await params;
  const hub = getHubIndex().security[grade] ?? notFound();
  return hubMeta('security', grade, 1, hub.totalEntries);
}

export default async function SecurityPage({ params }: { params: Params }) {
  const { grade } = await params;
  const hub = getHubIndex().security[grade] ?? notFound();
  return (
    <HubPage
      kind="security"
      hub={hub}
      entries={entriesForHub(hub, 1)}
      basePath={`/security/${grade}/`}
      page={1}
    />
  );
}
