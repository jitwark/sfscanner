import { ScannerClient } from '@/src/scanner/scanner-client';
import { ScannerGuide } from '@/src/ui/scanner-guide';
import { JsonLdScript, scannerJsonLd } from '../../src/seo/json-ld';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';
import { Breadcrumbs } from '@/src/ui/breadcrumbs';

export const metadata = {
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/scanner/') }),
  title: 'Workflow Scanner | n8n-secureflow',
  description:
    'Check one n8n workflow after the page loads. Review pasted credentials, open webhooks and shell execution locally; results are advisory.',
};

export default function ScannerPage() {
  return (
    <div>
      <JsonLdScript data={scannerJsonLd()} />

      <div className="mx-auto flex max-w-5xl flex-col gap-7">
        <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Scanner' }]} className="rounded-control" />

        <header className="flex max-w-3xl flex-col gap-3">
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-accent-text font-bold">
            Local workflow scanner
          </p>
          <h1 className="font-sans text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Check a workflow before you run it
          </h1>
          <p className="text-base leading-7 text-ink-muted">
            Paste or upload one workflow JSON export from n8n. See what the local scan found, what it
            could not assess, and what to review before import.
          </p>
        </header>

        <ScannerClient />

        <section aria-labelledby="scanner-purpose" className="border-t border-hairline pt-6">
          <h2 id="scanner-purpose" className="font-sans text-xl font-bold text-ink">What this review gives you</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-control border border-hairline bg-panel p-4">
              <h3 className="font-display text-sm font-semibold text-ink">Risk grade and score</h3>
              <p className="mt-1 text-sm leading-6 text-ink-muted">
                A triage signal from deterministic policy matches. No grade or score is shown when the
                scanner cannot support a risk decision.
              </p>
            </div>
            <div className="rounded-control border border-hairline bg-panel p-4">
              <h3 className="font-display text-sm font-semibold text-ink">Analysis coverage</h3>
              <p className="mt-1 text-sm leading-6 text-ink-muted">
                What was examined, omitted, unavailable, or refused. Coverage describes evidence limits;
                it is not a safety certificate.
              </p>
            </div>
            <div className="rounded-control border border-hairline bg-panel p-4">
              <h3 className="font-display text-sm font-semibold text-ink">Next actions</h3>
              <p className="mt-1 text-sm leading-6 text-ink-muted">
                Priority findings, remediation guidance, and declared prerequisites to confirm in n8n.
              </p>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-ink-muted">
            This is a static review of one JSON export. It does not execute the workflow or prove runtime
            safety. Library entries can have different coverage and versions, so rescan your exported copy
            before import.
          </p>
        </section>
        <ScannerGuide />
      </div>
    </div>
  );
}
