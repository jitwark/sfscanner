import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeCandidate, makeEntry } from './__fixtures__/make-entry.js';
import { isIndexable } from '@hub/contracts';
import { runEnrichCorpus, type EnrichCorpusOptions, type EnrichCorpusResult } from './enrich-corpus.js';
import { hashReleaseDirectory } from './package/release-metadata.js';

/**
 * These fixtures build scratch corpora in `pipeline/.work`, not release trees: they
 * stage no scanner sidecars, and a release manifest requires them. The tolerance is
 * named here rather than assumed by the builder — see `BuildManifestOptions`.
 */
function runScratchEnrich(options: EnrichCorpusOptions): EnrichCorpusResult {
  return runEnrichCorpus({ ...options, scannerSidecars: 'optional' });
}

const TEST_DATA_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-enrich-data-temp');
const TEST_CHECKPOINT_PATH = path.join(process.cwd(), 'pipeline', '.work', 'test-enrich-checkpoint.json');
const TEST_REPRO_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-enrich-repro-temp');
const TEST_REPRO_CHECKPOINT_PATH = path.join(process.cwd(), 'pipeline', '.work', 'test-enrich-repro-checkpoint.json');
const GENERATED_AT = '2026-08-13T12:00:00.000Z';

function makeDummyEntry(id: string): Entry {
  return makeEntry({
    id,
    slug: `slug-${id}`,
    title: `Workflow Title ${id}`,
    summary: `Summary ${id}`,
    description: id === 'no-desc' ? '' : `Upstream description for ${id}`,
    descriptionSource: id === 'no-desc' ? 'fallback' : 'upstream',
    source: {
      kind: 'github',
      repo: 'o/r',
      path: 'p.json',
      commit: '1234567890123456789012345678901234567890',
      author: { name: 'dev' },
    },
    rights: { status: 'redistributable', licence: 'MIT' },
    structure: {
      nodeCount: 3,
      connectionCount: 2,
      nodeTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.gmail'],
      integrations: ['webhook', 'gmail'],
      trigger: 'Webhook',
      complexity: 'simple',
      hasCode: false,
      hasAI: false,
      hasWebhook: true,
    },
    security: {
      grade: 'LOW',
      score: 95,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
      scannerVersion: '1.0.0',
      profile: 'beta-default',
    },
    tags: [],
    dedup: { fingerprint: `fp-${id}`, structuralHash: `sh-${id}`, canonical: true, alsoFoundIn: [] },
  });
}

describe('enrich-corpus', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_CHECKPOINT_PATH, { force: true });
    fs.rmSync(TEST_REPRO_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_REPRO_CHECKPOINT_PATH, { force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_CHECKPOINT_PATH, { force: true });
    fs.rmSync(TEST_REPRO_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_REPRO_CHECKPOINT_PATH, { force: true });
  });

  it('orchestrates enrichment and emits size table and budget checks', () => {
    const entries = [makeDummyEntry('1'), makeDummyEntry('2'), makeDummyEntry('no-desc')];
    const workflowsById = new Map<string, unknown>([
      ['1', { name: 'W1', nodes: [], connections: {} }],
      ['2', { name: 'W2', nodes: [], connections: {} }],
      ['no-desc', { name: 'W3', nodes: [], connections: {} }],
    ]);

    const result = runScratchEnrich({
      entries,
      workflowsById,
      outputDir: TEST_DATA_DIR,
      checkpointPath: TEST_CHECKPOINT_PATH,
      generatedAt: GENERATED_AT,
    });

    expect(result.totalEntries).toBe(3);
    expect(result.manifestSha256).toBeTruthy();
    expect(result.sizeTable.length).toBeGreaterThanOrEqual(6);
    expect(result.budgetsMet.searchIndexUnder8MB).toBe(true);
    expect(result.budgetsMet.homepageUnder200KB).toBe(true);

    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'catalogue-0.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'search-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'facets.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(TEST_CHECKPOINT_PATH)).toBe(true);

    const catalogue = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'catalogue-0.json'), 'utf8'));
    const noDescEntry = catalogue.find((e: Entry) => e.id === 'no-desc');
    expect(noDescEntry.description).toContain('automated simple n8n workflow');
    expect(noDescEntry.descriptionSource).toBe('fallback');
  });

  it('resumes from checkpoint on subsequent runs', () => {
    const entries = [makeDummyEntry('1'), makeDummyEntry('2')];
    const workflowsById = new Map<string, unknown>([
      ['1', makeCandidate({ id: '1' }).json],
      ['2', makeCandidate({ id: '2' }).json],
    ]);
    runScratchEnrich({
      entries,
      workflowsById,
      outputDir: TEST_DATA_DIR,
      checkpointPath: TEST_CHECKPOINT_PATH,
      generatedAt: GENERATED_AT,
    });

    const secondRunResult = runScratchEnrich({
      entries,
      workflowsById,
      outputDir: TEST_DATA_DIR,
      checkpointPath: TEST_CHECKPOINT_PATH,
      generatedAt: GENERATED_AT,
    });

    expect(secondRunResult.totalEntries).toBe(2);
  });

  it('throws on duplicate entry IDs', () => {
    const entries = [makeDummyEntry('dup'), makeDummyEntry('dup')];
    expect(() =>
      runScratchEnrich({
        entries,
        outputDir: TEST_DATA_DIR,
        checkpointPath: TEST_CHECKPOINT_PATH,
        generatedAt: GENERATED_AT,
      }),
    ).toThrow(/Duplicate entry ID/);
  });

  it('refuses to package an unresolved canonical entry when Gemini is required', () => {
    const entry = makeDummyEntry('unresolved');
    entry.description = '';
    entry.descriptionSource = 'fallback';
    expect(() => runScratchEnrich({
      entries: [entry],
      outputDir: TEST_DATA_DIR,
      checkpointPath: TEST_CHECKPOINT_PATH,
      requireGemini: true,
      generatedAt: GENERATED_AT,
    })).toThrow(/Gemini enrichment gate failed/);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'catalogue-0.json'))).toBe(false);
  });
  it('populates indexable field and fails pipeline if indexable ratio drops below 60% of redistributable canonicals', () => {
    const goodEntry = makeDummyEntry('good1');
    const badEntry1 = makeDummyEntry('bad1');
    badEntry1.descriptionSource = 'fallback';
    const badEntry2 = makeDummyEntry('bad2');
    badEntry2.descriptionSource = 'fallback';

    expect(() =>
      runScratchEnrich({
        entries: [goodEntry, badEntry1, badEntry2],
        outputDir: TEST_DATA_DIR,
        checkpointPath: TEST_CHECKPOINT_PATH,
        generatedAt: GENERATED_AT,
      }),
    ).toThrow(/SEO-3 Gate Failed/);
  });

  it('reproduces content hashes from identical clean inputs with a fixed release clock', () => {
    const entriesA = [makeDummyEntry('repro-a'), makeDummyEntry('repro-b')];
    const entriesB = [makeDummyEntry('repro-a'), makeDummyEntry('repro-b')];
    const workflowsA = new Map<string, unknown>([
      ['repro-a', { name: 'Repro A', nodes: [], connections: {} }],
      ['repro-b', { name: 'Repro B', nodes: [], connections: {} }],
    ]);
    const workflowsB = new Map(workflowsA);

    runScratchEnrich({ entries: entriesA, workflowsById: workflowsA, outputDir: TEST_DATA_DIR, checkpointPath: TEST_CHECKPOINT_PATH, generatedAt: GENERATED_AT });
    runScratchEnrich({ entries: entriesB, workflowsById: workflowsB, outputDir: TEST_REPRO_DIR, checkpointPath: TEST_REPRO_CHECKPOINT_PATH, generatedAt: GENERATED_AT });

    expect(hashReleaseDirectory(TEST_DATA_DIR)).toBe(hashReleaseDirectory(TEST_REPRO_DIR));
  });

  it('publishes a canonical official entry while still refusing to redistribute it', () => {
    const entry = makeDummyEntry('official');
    entry.source.kind = 'n8n_official';
    entry.rights = { status: 'link_only', licence: null, licenceUrl: null, reason: 'official' };

    // The two decisions are independent by design: we describe the workflow and
    // link to n8n.io for the file. `app/src/catalogue/download.ts` is the single
    // place that reads `rights.status`, and it still says no.
    expect(isIndexable(entry)).toBe(true);
    expect(entry.rights.status).toBe('link_only');
  });
});
