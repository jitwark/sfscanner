import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, EntryWithChart } from '@hub/contracts';
import type { DeepPartial } from '../__fixtures__/make-entry.js';
import { makeChart, makeEntry, makeRights, makeSource } from '../__fixtures__/make-entry.js';
import { totalSearchableDocuments } from '../derive/searchable-count.js';
import { buildSearchIndex } from '../index/build-search-index.js';
import { buildFacets } from '../index/facets.js';
import { writeArtifacts } from './write-artifacts.js';
import { buildManifest } from './manifest.js';

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-artifacts-temp');

function makeTestItem(id: string, overrides: DeepPartial<Entry> = {}): EntryWithChart {
  return {
    entry: makeEntry({
      id,
      slug: `slug-${id}`,
      title: `Title ${id}`,
      summary: `Summary ${id}`,
      description: `Description ${id}`,
      tags: ['test'],
      ...overrides,
    }),
    chart: makeChart(),
  };
}

describe('write-artifacts', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
  it('fails and reports missing workflow JSON for redistributable canonical entries', () => {
    const item = makeTestItem('missing-workflow', {
      title: 'Missing Workflow',
      rights: { status: 'redistributable', licence: 'MIT' },
      dedup: { canonical: true },
    });
    const searchRes = buildSearchIndex([item.entry]);
    const facetsData = buildFacets([item.entry]);

    expect(() =>
      writeArtifacts(
        [item],
        new Map<string, unknown>([['missing-workflow', undefined]]),
        searchRes,
        facetsData,
        TEST_DIR,
      ),
    ).toThrow(/1.*missing-workflow/);

    const report = JSON.parse(
      fs.readFileSync(path.join(TEST_DIR, 'missing-workflows.json'), 'utf8'),
    );
    expect(report).toEqual([
      { id: 'missing-workflow', title: 'Missing Workflow', source: item.entry.source },
    ]);
  });

  it('packages link-only entries without workflow JSON and omits download metadata', () => {
    const item = makeTestItem('link-only-no-body', {
      rights: { status: 'link_only', licence: null },
      dedup: { canonical: true },
    });
    const searchRes = buildSearchIndex([item.entry]);
    const facetsData = buildFacets([item.entry]);

    const written = writeArtifacts([item], new Map(), searchRes, facetsData, TEST_DIR, { legacyV1: true });

    expect(written.some((artifact) => artifact.relativePath.startsWith('packs/'))).toBe(false);
    expect(item.entry.download).toBeUndefined();
  });

  it('quarantines disconnected claims from every public projection', () => {
    const item = makeTestItem('broken-graph');
    item.chart = makeChart({
      nodes: [
        { id: 'a', name: 'A', type: 'trigger', x: 0, y: 0 },
        { id: 'b', name: 'B', type: 'set', x: 1, y: 1 },
      ],
      edges: [],
    });
    const written = writeArtifacts(
      [item], new Map([['broken-graph', { nodes: [], connections: {} }]]),
      buildSearchIndex([item.entry]), buildFacets([item.entry]), TEST_DIR,
      { legacyV1: true },
    );

    expect(JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'catalogue-0.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'quarantine-report.json'), 'utf8'))).toMatchObject({
      totalInput: 1, published: 0, quarantined: 1,
      entries: [{ id: 'broken-graph', reasons: ['GRAPH_INCOMPLETE', expect.any(String)] }],
    });
    expect(written.some((artifact) => artifact.relativePath === 'search-index.json' && artifact.entryCount === 0)).toBe(true);
  });


  it('enforces shard boundaries at 2,000 and pack boundaries at 250', () => {
    const totalCount = 2005;
    const items: EntryWithChart[] = [];
    const workflowsById = new Map<string, unknown>();

    for (let i = 0; i < totalCount; i++) {
      const id = `item-${i}`;
      const item = makeTestItem(id);
      items.push(item);
      workflowsById.set(id, { name: `Workflow ${id}`, nodes: [], connections: {} });
    }

    const entries = items.map((i) => i.entry);
    const searchRes = buildSearchIndex(entries);
    const facetsData = buildFacets(entries);

    const written = writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });

    expect(written.some((w) => w.relativePath === 'catalogue-0.json')).toBe(true);
    expect(written.some((w) => w.relativePath === 'catalogue-1.json')).toBe(true);

    const shard0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'catalogue-0.json'), 'utf8'));
    const shard1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'catalogue-1.json'), 'utf8'));

    expect(shard0.length).toBe(2000);
    expect(shard1.length).toBe(5);

    expect(written.some((w) => w.relativePath === 'packs/pack-8.jsonl')).toBe(true);
    const pack8Lines = fs
      .readFileSync(path.join(TEST_DIR, 'packs', 'pack-8.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(pack8Lines.length).toBe(5);
  });

  it('agrees with the manifest catalogueShards index on every entry\'s shard number', () => {
    const totalCount = 2005;
    const items: EntryWithChart[] = [];
    const workflowsById = new Map<string, unknown>();

    for (let i = 0; i < totalCount; i++) {
      const id = `shard-check-${i}`;
      items.push(makeTestItem(id));
      workflowsById.set(id, { name: `Workflow ${id}`, nodes: [], connections: {} });
    }

    const entries = items.map((i) => i.entry);
    const searchRes = buildSearchIndex(entries);
    const facetsData = buildFacets(entries);

    const written = writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });
    // A scratch tree, not a release tree: it stages no scanner sidecars.
    const { manifest } = buildManifest(TEST_DIR, written, '2026-08-13T12:00:00.000Z', undefined, { scannerSidecars: 'optional' });

    const index0 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-0.json'), 'utf8'));
    const index1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'details', 'detail-index-1.json'), 'utf8'));

    for (const item of items) {
      const id = item.entry.id;
      const shard = manifest.catalogueShards[id];
      const inClaimedIndex = shard === 0 ? index0 : shard === 1 ? index1 : undefined;
      expect(inClaimedIndex, `entry ${id} claims shard ${shard}`).toBeDefined();
      expect(inClaimedIndex![id]).toBeDefined();
    }
  });

  it('proves Range fast path and byte equality for JSONL line offsets', () => {
    const firstItem = makeTestItem('range-test-1');
    const secondItem = makeTestItem('range-test-2');
    const firstWorkflow = { name: 'Workflow range-test-1', nodes: [{ name: 'N1' }], connections: {} };
    const secondWorkflow = {
      name: 'Workflow range-test-2',
      nodes: [{ name: 'N1' }, { name: 'N2' }],
      connections: {},
    };
    const workflowsById = new Map<string, unknown>([
      ['range-test-1', firstWorkflow],
      ['range-test-2', secondWorkflow],
    ]);

    const items = [firstItem, secondItem];
    const searchRes = buildSearchIndex(items.map((item) => item.entry));
    const facetsData = buildFacets(items.map((item) => item.entry));

    writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });

    expect(firstItem.entry.download).toBeDefined();
    expect(secondItem.entry.download).toBeDefined();
    const firstDownload = firstItem.entry.download!;
    const secondDownload = secondItem.entry.download!;
    expect(firstDownload.offset).toBe(0);
    expect(secondDownload.pack).toBe(firstDownload.pack);
    expect(secondDownload.offset).toBe(firstDownload.length);

    const packPath = path.join(TEST_DIR, 'packs', `pack-${firstDownload.pack}.jsonl`);
    const packBuffer = fs.readFileSync(packPath);
    const firstLine = packBuffer
      .subarray(firstDownload.offset, firstDownload.offset + firstDownload.length)
      .toString('utf8');
    const secondLine = packBuffer
      .subarray(secondDownload.offset, secondDownload.offset + secondDownload.length)
      .toString('utf8');

    const expectedFirstLine = JSON.stringify(firstWorkflow) + '\n';
    const expectedSecondLine = JSON.stringify(secondWorkflow) + '\n';
    expect(firstDownload.length).toBe(Buffer.byteLength(expectedFirstLine, 'utf8'));
    expect(secondDownload.length).toBe(Buffer.byteLength(expectedSecondLine, 'utf8'));
    expect(firstLine).toBe(expectedFirstLine);
    expect(secondLine).toBe(expectedSecondLine);
    expect(JSON.parse(firstLine.trim())).toEqual(firstWorkflow);
    expect(JSON.parse(secondLine.trim())).toEqual(secondWorkflow);
    expect(firstDownload.sha256).toBe(createHash('sha256').update(Buffer.from(JSON.stringify(firstWorkflow), 'utf8')).digest('hex'));
    expect(secondDownload.sha256).toBe(createHash('sha256').update(Buffer.from(JSON.stringify(secondWorkflow), 'utf8')).digest('hex'));
  });

  it('removes stale manifest-owned packs before writing a smaller package', () => {
    fs.mkdirSync(path.join(TEST_DIR, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'packs', 'pack-99.jsonl'), 'stale\n');
    const item = makeTestItem('fresh-link-only', {
      rights: { status: 'link_only', licence: null },
      dedup: { canonical: true },
    });
    writeArtifacts([item], new Map(), buildSearchIndex([item.entry]), buildFacets([item.entry]), TEST_DIR, { legacyV1: true });
    expect(fs.existsSync(path.join(TEST_DIR, 'packs', 'pack-99.jsonl'))).toBe(false);
  });

  it('serializes download metadata that resolves first, middle, and last pack records', () => {
    const items = ['first', 'middle', 'last'].map((id) =>
      makeTestItem(`pack-${id}`, {
        rights: { status: 'redistributable', licence: 'MIT' },
        dedup: { canonical: true },
      }),
    );
    const workflowsById = new Map(
      items.map((item) => [item.entry.id, { name: item.entry.id, nodes: [], connections: {} }]),
    );
    const entries = items.map((item) => item.entry);

    writeArtifacts(
      items,
      workflowsById,
      buildSearchIndex(entries),
      buildFacets(entries),
      TEST_DIR,
      { legacyV1: true },
    );

    const catalogue = JSON.parse(
      fs.readFileSync(path.join(TEST_DIR, 'catalogue-0.json'), 'utf8'),
    ) as Entry[];
    const packBuffer = fs.readFileSync(path.join(TEST_DIR, 'packs', 'pack-0.jsonl'));

    for (const entry of catalogue) {
      expect(entry.download).toBeDefined();
      const download = entry.download!;
      const line = packBuffer
        .subarray(download.offset, download.offset + download.length)
        .toString('utf8')
        .trim();
      expect(JSON.parse(line)).toEqual(workflowsById.get(entry.id));
      expect(download.sha256).toBe(createHash('sha256').update(Buffer.from(line, 'utf8')).digest('hex'));
    }
  });

  it('omits official and link-only entries from workflow packs', () => {
    const officialItem = makeTestItem('official-1', {
      source: { kind: 'n8n_official', templateId: 100, permalink: 'https://n8n.io/workflows/100' },
      rights: { status: 'link_only', licence: null },
    });
    const linkOnlyItem = makeTestItem('linkonly-1', {
      rights: { status: 'link_only', licence: null },
    });
    const redistItem = makeTestItem('redist-1', {
      rights: { status: 'redistributable', licence: 'MIT' },
    });

    const items = [officialItem, linkOnlyItem, redistItem];
    const workflowsById = new Map<string, unknown>([
      ['official-1', { secret: 'should not be packed' }],
      ['linkonly-1', { secret: 'should not be packed' }],
      ['redist-1', { name: 'redist' }],
    ]);

    const searchRes = buildSearchIndex(items.map((i) => i.entry));
    const facetsData = buildFacets(items.map((i) => i.entry));

    writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });

    expect(officialItem.entry.download).toBeUndefined();
    expect(linkOnlyItem.entry.download).toBeUndefined();
    expect(redistItem.entry.download).toBeDefined();

    const packPath = path.join(TEST_DIR, 'packs', 'pack-0.jsonl');
    const packContent = fs.readFileSync(packPath, 'utf8');
    expect(packContent).not.toContain('should not be packed');
    expect(packContent).toContain('redist');
  });

  // The manifest stamped search-index.json with the corpus total while the
  // index held only the indexable subset — 13,221 claimed against 1,962 actual.
  // A count that is asserted rather than measured hides exactly the kind of
  // shortfall a manifest exists to surface.
  it('derives search-index entryCount from the index itself, not the corpus total', () => {
    const items = [
      makeTestItem('indexed-1', {
        rights: { status: 'redistributable', licence: 'MIT' },
        dedup: { canonical: true },
        structure: { nodeCount: 4, integrations: ['slack'] },
      }),
      // Link-only entries are excluded from the search index; the corpus total
      // therefore overstates it, which is the bug this test pins shut.
      makeTestItem('link-only-1', {
        rights: { status: 'link_only' },
        source: makeSource({ kind: 'n8n_official' }),
      }),
    ];
    const workflowsById = new Map<string, unknown>([['indexed-1', { name: 'indexed' }]]);
    const searchRes = buildSearchIndex(items.map((i) => i.entry));
    const facetsData = buildFacets(items.map((i) => i.entry));

    const written = writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });

    const searchArtifact = written.find((a) => a.relativePath === 'search-index.json');
    const documentCount = JSON.parse(searchRes.serializedIndex).documentCount;

    expect(searchArtifact?.entryCount).toBe(documentCount);
    expect(searchArtifact?.entryCount).not.toBe(items.length);
  });

  /**
   * `analytics.json` shipped in the manifest for a release without any pipeline
   * step emitting it: it had been assembled by hand. The next rebuild would have
   * dropped it from the manifest, left the stale file on disk, and failed
   * check:data-sync as an unowned extra — while the page went on presenting its
   * figures as measured. This pins it to the packager.
   */
});
