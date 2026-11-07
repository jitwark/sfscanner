import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono, Outfit } from 'next/font/google';
import './globals.css';
import { readAnalyticsSync } from '../src/catalogue/analytics-node';
import { getThemeBootstrapScript } from '../src/ui/theme/theme-script';
import { UtilityBar } from '../src/ui/utility-bar';
import { SiteHeader } from '../src/ui/site-header';
import { SiteFooter } from '../src/ui/site-footer';
import { robotsMetadata } from '../src/seo/robots';
import { CONTENT_SECURITY_POLICY } from '../src/seo/csp';
import { siteUrl } from '../src/seo/site-origin';

/**
 * Before this change, the design tokens named Inter, Outfit and JetBrains Mono,
 * but none of them were loaded: there was no `next/font`, no `@font-face`, no
 * stylesheet link, and zero `.woff2` assets in the export. They silently fell
 * back to the platform UI font and the display/body distinction never rendered.
 *
 * `next/font/google` self-hosts at build time, which keeps the static export
 * self-contained and makes no request to Google at runtime.
 *
 * The `<link rel="preload" as="font">` that `preload: true` — the default — is
 * documented to emit is absent from a **local Windows** export build, and no
 * project configuration can add it. It is a Next 16.3.4 defect in the webpack
 * path: the manifest that drives the tag is built by `NextFontManifestPlugin`,
 * which matches the module request against the POSIX substring
 * `'/next-font-loader/index.js?'`
 * (`next/dist/build/webpack/plugins/next-font-manifest-plugin.js:60`), while a
 * Windows request reads
 * `...\loaders\next-font-loader\index.js??ruleSet...`. The match never fires,
 * `next-font-manifest.json` ships `"app": {}`, and `getPreloadableFonts()`
 * returns null, so `preloadFont` is never called. On the Linux runner that
 * produces the published export (`.github/workflows/deploy.yml`, `ubuntu-latest`)
 * the request uses `/` separators and the match fires, so the shipped site does
 * emit the preload; the cost is confined to local Windows builds. Do not
 * hand-write the link and do not switch bundlers to get it locally:
 * `scripts/build-app.mjs` forces `--webpack` for the reason recorded there.
 */
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const outfit = Outfit({ subsets: ['latin'], display: 'swap', variable: '--font-outfit' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-jetbrains-mono' });

/**
 * The policy itself lives in `src/seo/csp.ts` so it has one testable value.
 * See that file for why `'unsafe-inline'` scripts are unavoidable here and why
 * `frame-ancestors` is deliberately absent.
 */

export const metadata: Metadata = {
  ...(siteUrl() ? { metadataBase: new URL(siteUrl() as string) } : {}),
  title: 'n8n-secureflow',
  // "zero-knowledge" is a specific cryptographic term and this is not one; it was already
  // scrubbed from the scanner page's own copy. This description is shown on every page's
  // search and social snippet, so it was the widest-reaching place the word survived.
  description: 'Community workflow catalogue & in-browser security scanner for n8n.',
  robots: robotsMetadata(true),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // One source for "how many can I find", shared with the analytics page.
  //
  // This read `search-index.json`'s own `documentCount`, which was right until
  // the index was split into tiers — then it reported 2,000 on every page while
  // the analytics page said 12,923. That is the same two-different-sizes-on-one-
  // screen bug it was written to fix, arriving from the other direction, and a
  // per-file derivation is what let it. It also pulled a 6 MB JSON into the
  // build graph to read a single number.
  const searchableCount = readAnalyticsSync().searchable;

  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${outfit.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CONTENT_SECURITY_POLICY} />
        <script dangerouslySetInnerHTML={{ __html: getThemeBootstrapScript() }} />
      </head>
      <body className="flex min-h-screen flex-col bg-page font-sans text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-control focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-ink"
        >
          Skip to main content
        </a>

        <UtilityBar />
        <SiteHeader searchableCount={searchableCount} />

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>

        <SiteFooter />
      </body>
    </html>
  );
}
