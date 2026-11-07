import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allEntries, indexableSlugs, qualityScore, relatedIndex } from '@/src/catalogue/prerender-list';
import { readPreviewSync } from '@/src/catalogue/preview-node';
import { entryMeta } from '@/src/seo/page-meta';
import { computeRelated } from '@/src/catalogue/related';
import { DetailBody } from '@/src/ui/detail/detail-body';
import { JsonLdScript, entryJsonLd } from '@/src/seo/json-ld';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  const entries = process.env.NODE_ENV === 'development' ? allEntries() : null;
  const slugs = entries ? entries.map((e) => e.slug) : indexableSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const entries = allEntries();
  const entry = entries.find((e) => e.slug === slug);
  if (!entry) {
    return { title: 'Workflow Not Found · n8n-secureflow' };
  }
  return entryMeta(entry);
}

export default async function WorkflowDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const entries = allEntries();
  const entry = entries.find((e) => e.slug === slug);

  if (!entry) {
    notFound();
  }

  const related = computeRelated(entry, entries, 6, qualityScore, relatedIndex());
  const preview = readPreviewSync(entry);

  return (
    <>
      <JsonLdScript data={entryJsonLd(entry)} />
      <DetailBody entry={entry} preview={preview} related={related} initialLayout="workbench" />
    </>
  );
}
