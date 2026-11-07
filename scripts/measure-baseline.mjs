#!/usr/bin/env node
/**
 * P0.4 performance/accessibility/product baseline measurement.
 *
 * Reads the already-built `app/out` static export through the same
 * `app/e2e/static-server.mjs` the E2E suite uses (not `next dev` — HMR/dev
 * overhead would measure the dev server, not the shipped product). Emits a
 * JSON snapshot plus a summary the Phase 0 baseline doc links to.
 *
 * These are provisional ratchets on one machine/network profile, per
 * docs/superpowers/plans/luna-production-readiness/02-phase-0-control-baseline-legal.md
 * P0.4 — Phase 6 (static-performance-and-caching) converts them into approved
 * budgets after redesign work, not this script.
 *
 * Usage: node scripts/measure-baseline.mjs [baseURL]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { measureLibraryPage } from './lib/measure-baseline-library.mjs';
import { measurePage } from './lib/measure-baseline-page.mjs';
import { measureScannerPage } from './lib/measure-baseline-scanner.mjs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3210';
const WIDTHS = [320, 768, 1024, 1440];

const ROUTES = [
  { path: '/', label: 'home' },
  { path: '/library/', label: 'library' },
  { path: '/scanner/', label: 'scanner' },
  { path: '/analytics/', label: 'analytics' },
  { path: '/sources/', label: 'sources' },
  { path: '/about/', label: 'about' },
  { path: '/privacy/', label: 'privacy' },
  { path: '/terms/', label: 'terms' },
  { path: '/takedown/', label: 'takedown' },
  { path: '/tags/', label: 'tags-hub' },
  { path: '/tags/code/', label: 'tags-detail' },
  { path: '/integrations/', label: 'integrations-hub' },
  { path: '/integrations/http-request/', label: 'integrations-detail' },
  { path: '/triggers/webhook/', label: 'triggers-detail' },
  { path: '/security/critical/', label: 'security-grade' },
  { path: '/does-not-exist-baseline-probe/', label: 'not-found' },
];

const WORKFLOWS = [
  { id: '1cf243171c73ee0f', slug: 'advanced-multi-agent-ai-personal-assistant-with-250-task-capabilities-whatsapp-gpt-1cf24317', label: 'large-prerendered-206node', kind: 'prerendered' },
  { id: '63234c681acd79ec', slug: 'jarvis-ai-personal-assistant-with-multi-agent-network-via-whatsapp-63234c68', label: 'large-lean-206node', kind: 'view' },
  { id: '0bba956648ad2fe0', slug: 'pick-a-topic-auto-publish-translated-content-on-multiple-social-media-platform-0bba9566', label: 'medium-lean-30node', kind: 'view' },
  { id: '092bd9ff4562c002', slug: 'receive-updates-on-appointments-via-acuity-scheduling-092bd9ff', label: 'small-lean-1node', kind: 'view' },
];

async function main() {
  const browser = await chromium.launch();
  const results = { capturedAt: new Date().toISOString(), baseURL, routes: {}, workflows: {}, scanner: {}, library: {} };

  // 1. Route matrix at four widths.
  for (const route of ROUTES) {
    results.routes[route.label] = {};
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      try {
        results.routes[route.label][width] = await measurePage(page, baseURL + route.path, width);
      } finally {
        await page.close();
      }
    }
  }

  // 2. Workflow detail DOM/SVG weight, one width for volume, plus 320 for overflow.
  for (const wf of WORKFLOWS) {
    const url = wf.kind === 'prerendered' ? `${baseURL}/w/${wf.slug}/` : `${baseURL}/w/view/?id=${wf.id}`;
    results.workflows[wf.label] = {};
    for (const width of [1440, 320]) {
      const page = await browser.newPage();
      try {
        results.workflows[wf.label][width] = await measurePage(page, url, width);
      } finally {
        await page.close();
      }
    }
  }

  // 3. Scanner: page height before/after a scan, and scan wall-clock time.
  {
    const page = await browser.newPage();
    results.scanner = await measureScannerPage(page, baseURL);
    await page.close();
  }

  // 4. Library: mounted filter DOM height/count, and a search-query timing sample.
  {
    const page = await browser.newPage();
    results.library = await measureLibraryPage(page, baseURL);
    await page.close();
  }

  await browser.close();

  const outDir = path.resolve('docs/audit/2026-08-26/baseline');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'perf-a11y-baseline.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote ${path.join(outDir, 'perf-a11y-baseline.json')}`);
}

await main();
