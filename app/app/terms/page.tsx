import type { Metadata } from 'next';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { LegalPage } from '../../src/ui/legal/legal-page';
import { TermsBody } from '../../src/ui/legal/terms-body';
import { lastUpdated } from '../../src/ui/legal/legal-contacts';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Terms · n8n-secureflow',
  description:
    'What this site is, what the catalogue contains, what the security grades do and do not mean, and the terms under which it is provided.',
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/terms/') }),
};

export default function TermsPage() {
  return (
    <>
      <JsonLdScript
        data={pageJsonLd({
          name: 'Terms',
          path: '/terms/',
          description:
            'Terms of use for the n8n-secureflow catalogue and browser-local workflow scanner.',
        })}
      />
      <LegalPage
        title="Terms"
        updated={lastUpdated}
        intro={
          <>
            <p>
              There is nothing to sign up for and nothing to agree to, because there is no account
              and nothing is collected. This page is a notice of the terms the site is provided
              under, not a contract you are asked to accept.
            </p>
            <p className="mt-3">
              The part worth reading is{' '}
              <a className="text-accent-text underline underline-offset-2" href="#no-warranty">
                what a security grade does not mean
              </a>
              .
            </p>
          </>
        }
      >
        <TermsBody />
      </LegalPage>
    </>
  );
}
