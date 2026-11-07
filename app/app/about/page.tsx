import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '@/src/ui/breadcrumbs';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';
import { PublicRequestLink } from '../../src/ui/legal/takedown-contact';
import { productRepositoryUrl } from '../../src/ui/product-links';

export const metadata: Metadata = {
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/about/') }),
  title: 'About · n8n-secureflow',
  description: 'Learn about the n8n-secureflow catalogue, automated security scanning, and content policies.',
};

export default function AboutPage() {
  const repositoryUrl = productRepositoryUrl();
  const breadcrumbItems = [
    { label: 'Home', href: '/' },
    { label: 'About', href: '/about/' },
  ];

  return (
    <article className="max-w-3xl space-y-8">
      <JsonLdScript data={pageJsonLd({ name: 'About', path: '/about/', description: 'What n8n-secureflow indexes, where the workflows come from, how they are licensed, and how to have one removed.', })} />
      <Breadcrumbs items={breadcrumbItems} />

      <header className="space-y-3">
        <h1 className="text-3xl font-display font-semibold text-ink">About n8n-secureflow</h1>
        <p className="text-lg text-ink-muted leading-relaxed">
          An open catalogue of public n8n workflows paired with automated security static analysis.
        </p>
      </header>

      <section className="space-y-4 border-t border-hairline pt-6">
        <h2 className="text-xl font-display font-semibold text-ink">What This Project Is</h2>
        <p className="text-ink-muted leading-relaxed">
          n8n-secureflow indexes and analyzes workflows created by the n8n community and published across
          open public GitHub repositories and official template directories. It provides structural inspection,
          integration mapping, and static security checks to help developers evaluate workflows before importing them.
        </p>
      </section>

      <section className="space-y-4 border-t border-hairline pt-6">
        <h2 className="text-xl font-display font-semibold text-ink">How the Corpus Is Built</h2>
        <p className="text-ink-muted leading-relaxed">
          The catalogue is built through automated pipeline acquisition runs from curated GitHub repositories and
          official template sources. Each candidate workflow undergoes JSON structural parsing, licensing verification,
          deduplication, and security analysis.
        </p>
        <p className="text-ink-muted leading-relaxed">
          No workflow body is hosted here. Every entry is link-only: the page publishes derived analysis — structure,
          security findings, readiness — plus a link to the exact upstream source. No download packs ship
          with this release.
          The last rows that shipped a body (288 of them, all with a repository licence but no recorded per-item
          licence evidence) were moved to link-only on 2026-09-27.
        </p>
      </section>

      <section className="space-y-4 border-t border-hairline pt-6">
        <h2 className="text-xl font-display font-semibold text-ink">Scanner Advisory Status</h2>
        <p className="text-ink-muted leading-relaxed">
          The built-in security scanner is a static analysis engine designed to flag potential risks, unencrypted credentials,
          suspicious code patterns, and dangerous node configurations.
        </p>
        <p className="text-ink-muted leading-relaxed">
          Scanner findings and security grades are advisory markers generated automatically by static rules. They do not
          guarantee absolute safety or maliciousness. Always review workflow logic and credential requirements before running
          untrusted code in production environments.
        </p>
      </section>

      <section className="space-y-4 border-t border-hairline pt-6">
        <h2 className="text-xl font-display font-semibold text-ink">Open Source & Community</h2>
        <p className="text-ink-muted leading-relaxed">
          {repositoryUrl ? (
            <>
              Source code, deterministic security rules, and pipeline tools live in the project repository:{' '}
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-text underline underline-offset-2 hover:brightness-110 font-mono text-sm"
              >
                {repositoryUrl}
              </a>
              .
            </>
          ) : (
            'Source code, deterministic security rules, and pipeline tools live in the project repository, which is not publicly available at the time of this build.'
          )}
        </p>
      </section>

      <section className="space-y-4 border-t border-hairline pt-6">
        <h2 className="text-xl font-display font-semibold text-ink">Takedown Procedure</h2>
        <p className="text-ink-muted leading-relaxed">
          If you are a copyright holder, repository owner, or the subject of a workflow indexed here and wish to
          request its removal, use the{' '}
          <Link href="/takedown/" className="text-accent-text underline underline-offset-2">
            takedown request page
          </Link>{' '}
          rather than a public channel. It will ask you for:
        </p>
        <ul className="list-disc list-inside text-ink-muted space-y-1 font-mono text-sm pl-2">
          <li>The workflow title or URL on this site</li>
          <li>Upstream repository URL or proof of ownership</li>
          <li>Specific reason for the takedown request</li>
        </ul>
        <p className="text-ink-muted leading-relaxed pt-2">
          Takedown requests are processed promptly, and affected entries will be removed from future index builds.
        </p>
        <p className="text-ink-muted leading-relaxed">
          Routine licence corrections containing no personal data, credentials, or security details may use a{' '}
          <PublicRequestLink />. Use the private contact on the request page for anything sensitive.
        </p>
      </section>
    </article>
  );
}
