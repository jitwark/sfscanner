import { ScannerClient } from '@/src/scanner/scanner-client';
import { ScannerGuide } from '@/src/ui/scanner-guide';
import { JsonLdScript, scannerJsonLd } from '../../src/seo/json-ld';
import Link from 'next/link';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';
import { Breadcrumbs } from '@/src/ui/breadcrumbs';

export const metadata = {
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/scanner/') }),
  title: 'Workflow Scanner | n8n-secureflow',
  description:
    'Check an n8n workflow before you import it. Finds pasted credentials, open webhooks and shell execution, entirely in your browser.',
};

export default function ScannerPage() {
  return (
    <div>
      <JsonLdScript data={scannerJsonLd()} />

      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Scanner' }]} className="rounded-control" />

        <header className="flex max-w-2xl flex-col gap-3">
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-accent-text font-bold">
            Local workflow scanner
          </p>
          <h1 className="font-sans text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Check a workflow before you run it
          </h1>
          <p className="text-base leading-7 text-ink-muted">
            Review workflow structure, declared prerequisites, and supported security checks before importing an n8n workflow.
          </p>
        </header>

        <ScannerClient />

        <section aria-labelledby="scanner-purpose" className="max-w-3xl border-t border-hairline pt-6">
          <h2 id="scanner-purpose" className="border-b border-hairline pb-2 font-sans text-xl font-bold text-ink">What the report helps you review</h2>
          <p className="mt-3 text-sm leading-6 text-ink-muted">
            It answers three questions: <strong className="font-semibold text-ink">is a credential
            sitting in this file</strong>, <strong className="font-semibold text-ink">can this reach
            further than a workflow should</strong>, and{' '}
            <strong className="font-semibold text-ink">what will it need from me</strong>. Every
            workflow in our{' '}
            <Link href="/library/" prefetch={false} className="text-accent-text underline decoration-hairline-strong underline-offset-2 hover:decoration-current">
              library
            </Link>{' '}
            has already been through the same checks.
          </p>
        </section>
        <ScannerGuide />
      </div>
    </div>
  );
}
