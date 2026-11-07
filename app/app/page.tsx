import type { Metadata } from 'next';
import Link from 'next/link';
import type { Entry } from '@hub/contracts';
import { allEntries, featured } from '../src/catalogue/prerender-list';
import { readAnalyticsSync } from '../src/catalogue/analytics-node';
import { readManifestSync } from '../src/catalogue/manifest-node';
import { getHubIndex } from '../src/catalogue/hub-index';
import type { FacetCounts } from '../src/search/facet-bitset';
import { FeaturedRail } from '../src/ui/featured-rail';
import { HomeFacts } from '../src/ui/home-facts';
import { HomeHubLinks } from '../src/ui/home-hub-links';
import { HomeSearch } from '../src/ui/home-search';
import { HomeTools } from '../src/ui/home-tools';
import { HeroWorkflowFlare } from '../src/ui/hero-workflow-flare';
import { IdlePrefetch } from '../src/ui/idle-prefetch';
import { JsonLdScript, homeJsonLd } from '../src/seo/json-ld';
import { canonicalAlternates } from '../src/seo/page-meta';
import { isPreviewBuild } from '../src/seo/robots';

export const metadata: Metadata = {
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/') }),
};

type Facets = { counts: FacetCounts };

function dataPath(relative: string): string {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(process.cwd(), 'public', 'data', relative),
    path.join(process.cwd(), '..', 'data', relative),
    path.join(process.cwd(), 'app', 'public', 'data', relative),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function readJson<T>(relative: string): T {
  const fs = require('fs');
  return JSON.parse(fs.readFileSync(dataPath(relative), 'utf8')) as T;
}

/**
 * One entry per place the corpus actually came from: each distinct GitHub
 * repository, plus a single bucket for the official n8n template API.
 *
 * This used to count distinct `kind:repo-or-templateId` combinations, which
 * is a count of source *records* (11,089 of them: mostly distinct official
 * template IDs, each counted separately) under a label ("Sources") that
 * claims to count where the corpus was drawn from. Every official-template
 * entry now collapses into one 'official' bucket regardless of its
 * `templateId`, matching the "nine public sources" the catalogue actually has
 * (README.md, `pipeline/sources.json`). See AUDIT-CLAIM-001.
 */
export function sourceCount(entries: Entry[]): number {
  const origins = new Set(
    entries.map((entry) => (entry.source.kind === 'github' ? `github:${entry.source.repo}` : 'official')),
  );
  return origins.size;
}

/**
 * The release manifest's `generatedAt` is when this package was built. An
 * entry's `fetchedAt` only says when that one record was last pulled from its
 * origin -- the newest of those is not a rebuild date, it is a fetch date.
 * See AUDIT-CLAIM-001.
 */
export function buildDate(generatedAt: string): string {
  return generatedAt.slice(0, 10);
}

export default function HomePage() {
  const entries = allEntries();
  const facetCounts = readJson<Facets>('facets.json').counts;
  const analytics = readAnalyticsSync();
  const manifest = readManifestSync();
  const compact = (value: number) => value.toLocaleString('en-US');

  return (
    <div className="flex w-full flex-col pb-10">
      <IdlePrefetch />
      <JsonLdScript data={homeJsonLd()} />

      {/* Hero Chapter */}
      <section className="-mx-4 -mt-8 mb-12 border-b border-hairline bg-page px-4 py-12 text-ink sm:-mx-6 sm:px-6 lg:py-16">
        <div className="mx-auto grid max-w-7xl min-w-0 grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,auto)]">
          <div className="flex max-w-3xl flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 bg-accent" aria-hidden="true" />
                <p className="font-mono text-2xs uppercase tracking-wider text-accent-text font-bold">
                  Open Community Index · Deterministic Scanner
                </p>
              </div>
              <h1 className="font-sans text-3xl font-bold leading-[1.15] tracking-tight text-ink sm:text-4xl lg:text-[44px]">
                Find the workflow you need, then check it before you run it.
              </h1>
              <p className="max-w-[62ch] text-base leading-7 text-ink-muted">
                Search {compact(analytics.searchable)} community workflows by integration, trigger and
                security grade, then scan any workflow JSON before you import it.
              </p>
            </div>

            <div className="flex max-w-2xl flex-col gap-2.5">
              <HomeSearch />
              <p className="font-mono text-2xs text-ink-muted">
                The scanner runs locally in your browser. Nothing is uploaded.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link
                href="/scanner/"
                className="inline-flex h-11 items-center justify-center rounded-control bg-accent px-6 font-sans text-sm font-bold text-accent-ink transition-colors hover:brightness-95 active:brightness-90"
              >
                Scan a Workflow
              </Link>
              <Link
                href="/library/"
                prefetch={false}
                className="inline-flex h-11 items-center justify-center rounded-control border border-hairline bg-raised px-6 font-sans text-sm font-bold text-ink transition-colors hover:bg-page hover:border-hairline-strong"
              >
                Browse Library
              </Link>
            </div>
          </div>

          <HeroWorkflowFlare />
        </div>
      </section>

      {/* Body Content Chapters: Flat paper-white canvas */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-14">
        <HomeTools />

        <HomeFacts
          facts={[
            { label: 'Workflows', value: compact(analytics.total), detail: 'after de-duplication' },
            {
              label: 'Searchable',
              value: compact(analytics.searchable),
              detail: `${((analytics.searchable / Math.max(1, analytics.total)) * 100).toFixed(0)}% of the catalogue`,
            },
            { label: 'Findings', value: compact(analytics.findings.totalOccurrences), detail: `${analytics.findings.policies.length} rules` },
            { label: 'Sources', value: compact(sourceCount(entries)), detail: `rebuilt ${buildDate(manifest.generatedAt)}` },
          ]}
        />

        <FeaturedRail entries={featured(12)} />

        {/* CTA Bridge Strip */}
        <section
          aria-label="Scanner call to action"
          className="relative flex flex-col items-center justify-between gap-6 rounded-panel border border-hairline bg-panel p-8 sm:flex-row sm:p-10 text-ink"
        >
          <div className="flex flex-col gap-2">
            <span className="font-mono text-2xs uppercase tracking-wider text-accent-text font-bold">
              In-Browser Security Inspection
            </span>
            <h2 className="font-sans text-2xl font-bold tracking-tight text-ink">
              Verify your n8n workflows before deployment
            </h2>
            <p className="max-w-xl text-sm leading-6 text-ink-muted">
              Deterministic AST & taint analysis runs 100% client-side with zero telemetry.
            </p>
          </div>
          <Link
            href="/scanner/"
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-control bg-accent px-6 font-sans text-sm font-bold text-accent-ink transition-colors hover:brightness-95 active:brightness-90"
          >
            Launch Scanner
          </Link>
        </section>

        <HomeHubLinks index={getHubIndex()} counts={facetCounts} />
      </div>
    </div>
  );
}
