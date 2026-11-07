#!/usr/bin/env node
/** Measure cold/repeat library search runtime against a built static export. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:3210';
const QUERY_SAMPLES = ['slack notification', 'webhook form', 'gmail email', 'schedule report', 'discord alert'];
const WORKER_READY_MARK = 'secureflow:search-worker-ready';

export function percentile(values, percent) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (percent / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function summarizeResourceEntries(entries) {
  const summary = { requests: entries.length, transferBytes: 0, encodedBytes: 0, decodedBytes: 0, unavailable: [] };
  for (const entry of entries) {
    for (const [field, output] of [['transferSize', 'transferBytes'], ['encodedBodySize', 'encodedBytes'], ['decodedBodySize', 'decodedBytes']]) {
      const value = entry[field];
      if (Number.isFinite(value) && value >= 0) summary[output] += value;
      else if (!summary.unavailable.includes(field)) summary.unavailable.push(field);
    }
  }
  return summary;
}

export function summarizeResponses(responses) {
  const summary = { responses: responses.length, contentLengthBytes: 0, knownContentLengthResponses: 0 };
  for (const response of responses) {
    const length = response.contentLength == null ? NaN : Number(response.contentLength);
    if (Number.isFinite(length) && length >= 0) {
      summary.contentLengthBytes += length;
      summary.knownContentLengthResponses += 1;
    }
  }
  return summary;
}

async function measurePage(browser, baseURL, label, query = false) {
  const page = await browser.newPage();
  const responses = [];
  const started = performance.now();
  page.on('response', async (response) => {
    const contentLength = response.headers()['content-length'];
    responses.push({ url: response.url(), contentLength: contentLength ?? null });
  });
  await page.goto(`${baseURL}/library/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('combobox', { name: 'Search n8n workflows' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => performance.getEntriesByType('resource').some((entry) => entry.name.includes('/data/search-index.json')),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (markName) => performance.getEntriesByName(markName).length > 0,
    WORKER_READY_MARK,
    { timeout: 30_000 },
  );
  const navigationMs = Math.round(performance.now() - started);
  const workerInitMs = await page.evaluate((markName) => {
    const mark = performance.getEntriesByName(markName)[0];
    return mark ? Math.round(mark.startTime) : null;
  }, WORKER_READY_MARK);
  const navigation = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null);
  let queryMs = null;
  let querySamplesMs = [];
  if (query) {
    const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
    for (const value of QUERY_SAMPLES) {
      const previousState = await page.evaluate(() => ({
        count: document.querySelector('section[aria-labelledby="library-results-heading"] p[aria-live]')?.textContent ?? null,
        firstHref: document.querySelector('#search-results-list a')?.getAttribute('href') ?? null,
      }));
      const queryStarted = performance.now();
      await search.fill(value);
      await page.waitForFunction(
        ({ selector, previous }) => {
          const count = document.querySelector(selector)?.textContent ?? null;
          const firstHref = document.querySelector('#search-results-list a')?.getAttribute('href') ?? null;
          return count !== previous.count || firstHref !== previous.firstHref;
        },
        { selector: 'section[aria-labelledby="library-results-heading"] p[aria-live]', previous: previousState },
        { timeout: 30_000 },
      );
      querySamplesMs.push(Math.round(performance.now() - queryStarted));
    }
    queryMs = querySamplesMs[0] ?? null;
  }
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize,
  })));
  const memory = await page.evaluate(() => {
    const value = (performance).memory?.usedJSHeapSize;
    return Number.isFinite(value) ? value : null;
  });
  await page.close();
  return {
    label,
    navigationMs,
    queryMs,
    querySamplesMs,
    queryP50Ms: percentile(querySamplesMs, 50),
    queryP95Ms: percentile(querySamplesMs, 95),
    workerInitMs,
    navigationTimingMs: navigation?.loadEventEnd ? Math.round(navigation.loadEventEnd) : null,
    memoryUsedBytes: memory,
    requests: summarizeResourceEntries(resources),
    responses: summarizeResponses(responses),
  };
}

export async function measureSearchRuntime(baseURL = DEFAULT_URL) {
  const browser = await chromium.launch();
  try {
    const cold = await measurePage(browser, baseURL, 'cold');
    const repeat = await measurePage(browser, baseURL, 'repeat');
    const queried = await measurePage(browser, baseURL, 'query', true);
    const unavailable = ['deviceCPU', 'deviceMemory'];
    if (cold.workerInitMs === null && repeat.workerInitMs === null && queried.workerInitMs === null) unavailable.push('workerInitMs');
    return {
      schemaVersion: 'search-runtime-measurement-v2',
      baseURL,
      capturedAt: new Date().toISOString(),
      runs: { cold, repeat, query: queried },
      unavailable,
      notes: ['Query resource fields aggregate the fixed five-query distribution; queryMs is its first sample.', 'workerInitMs is the page-relative performance mark emitted after the worker reports ready.', 'Transfer fields are browser resource-timing values; content-length is server-header evidence.', 'Run repeatedly on named devices before proposing ratchets.'],
    };
  } finally {
    await browser.close();
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/measure-search-runtime.mjs [--url URL] [--out FILE]\n');
  } else {
    const output = resolve(option('--out', 'pipeline/.work/search-runtime-measurement.json'));
    const result = await measureSearchRuntime(option('--url', DEFAULT_URL));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`Wrote ${output}\n`);
  }
}
