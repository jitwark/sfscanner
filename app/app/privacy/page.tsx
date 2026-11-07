import type { Metadata } from 'next';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { sitePath } from '../../src/ui/site-url.mjs';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Privacy · n8n-secureflow',
  description:
    'What this site does and does not collect. The workflow scanner runs entirely in your browser and never uploads your workflow.',
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/privacy/') }),
};

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-[68ch]">
      <JsonLdScript data={pageJsonLd({ name: 'Privacy', path: '/privacy/', description: 'The scanner runs entirely in your browser. No accounts, no cookies, no analytics, and no workflow ever leaves your machine.', })} />
      <h1 className="text-3xl">Privacy</h1>

      <p className="mt-6 text-ink-muted">
        This page describes what the site does, in plain terms. It is short because the site does
        very little.
      </p>

      <h2 className="mt-12 text-xl">The scanner never uploads your workflow</h2>
      <p className="mt-3 text-ink-muted">
        When you paste or drop a workflow into the scanner, it is analysed by code running inside
        your own browser, in a Web Worker. The workflow is never sent anywhere. There is no server
        to send it to: this site is a set of static files. You can verify that yourself by opening
        your browser&rsquo;s network panel and running a scan, or by reading the scanner source in
        the repository.
      </p>

      <h2 className="mt-12 text-xl">No accounts, no cookies, no analytics</h2>
      <p className="mt-3 text-ink-muted">
        There is no sign-up, no login, and no user record of any kind. The site sets no cookies and
        does not store workflow contents in local storage. It may store your selected theme
        preference locally, and your browser may cache the static files it downloads. No analytics,
        tracking pixels, session recording, or third-party scripts are loaded. Nobody is counting
        your visit.
      </p>

      <h2 className="mt-12 text-xl">What the host can see</h2>
      <p className="mt-3 text-ink-muted">
        The static files are served by a hosting provider, including Firebase Hosting when a
        preview is deployed there. That hosting provider may observe or retain request metadata
        such as your IP address, the file requested, and your user agent under its own policies.
        This site does not use that hosting metadata to identify scanner input or workflow contents.
      </p>

      <h2 className="mt-12 text-xl">Where the catalogue comes from</h2>
      <p className="mt-3 text-ink-muted">
        Every workflow in the library was published publicly by someone else. Each entry records
        where it came from: the repository, the exact commit, the file path, the licence, and the
        author. No workflow body is hosted here: every entry links back to the original, and no
        download packs ship with this release. Credentials and secret-looking values are stripped
        before a workflow is stored or shown.
      </p>

      <h2 className="mt-12 text-xl">Removal</h2>
      <p className="mt-3 text-ink-muted">
        If you own a workflow or a repository indexed here and you want it gone, use the{' '}
        <a className="text-accent-text underline underline-offset-2" href={sitePath('/takedown/')}>
          takedown request page
        </a>
        {' '}and it will be removed the next time the corpus is rebuilt. Rebuilds are an
        operator-triggered process, not a fixed schedule.
      </p>

      <h2 className="mt-12 text-xl">If this changes</h2>
      <p className="mt-3 text-ink-muted">
        Should anonymous, aggregate usage counting ever be added, it will be stated here first, it
        will be cookieless, and it will never include the contents of a scanned workflow.
      </p>
    </article>
  );
}
