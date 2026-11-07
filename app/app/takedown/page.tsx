import type { Metadata } from 'next';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { LegalPage } from '../../src/ui/legal/legal-page';
import { TakedownCopyright } from '../../src/ui/legal/takedown-copyright';
import { TakedownOtherRequests } from '../../src/ui/legal/takedown-other-requests';
import { lastUpdated } from '../../src/ui/legal/legal-contacts';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Removal requests · n8n-secureflow',
  description:
    'How to ask for a workflow, a source, or your personal details to be removed: copyright, licence corrections, personal data, and security reports.',
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/takedown/') }),
};

export default function TakedownPage() {
  return (
    <>
      <JsonLdScript
        data={pageJsonLd({
          name: 'Removal requests',
          path: '/takedown/',
          description:
            'How to request removal of a workflow, a source, or personal data from the n8n-secureflow catalogue.',
        })}
      />
      <LegalPage
        title="Removal requests"
        updated={lastUpdated}
        intro={
          <>
            <p>
              This catalogue indexes workflows other people published, and records who wrote them.
              If something here is yours and you want it changed or gone, this page is how to say
              so. Requests are read and acted on; you do not need an account anywhere to make one.
            </p>
            <p className="mt-3">
              There are four kinds of request and they work differently. Pick the one that matches
              what you are asking for — it decides what evidence is needed and how fast the answer
              comes.
            </p>
          </>
        }
      >
        <nav aria-label="Request types" className="rounded-panel border border-hairline bg-panel p-4">
          <ul className="grid gap-2 sm:grid-cols-2">
            {[
              { href: '#copyright', label: 'Copyright removal (DMCA)' },
              { href: '#licence', label: 'Licence correction' },
              { href: '#personal-data', label: 'Personal data' },
              { href: '#security', label: 'Security disclosure' },
            ].map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="flex min-h-11 items-center rounded-control px-2 font-mono text-xs text-accent-text transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent-border"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <TakedownCopyright />
        <TakedownOtherRequests />
      </LegalPage>
    </>
  );
}
