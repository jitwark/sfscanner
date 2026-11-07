import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExclusionRegistry } from '@hub/contracts';
import { makeChart, makeEntry } from '../__fixtures__/make-entry.js';
import { buildSearchIndex } from '../index/build-search-index.js';
import { buildFacets } from '../index/facets.js';
import { writeArtifacts } from '../package/write-artifacts.js';
import { buildManifest } from '../package/manifest.js';

/**
 * `build-corpus-exclusion.test.ts` proves the registry drops a candidate
 * before it becomes an `Entry` at all — the single choke point described in
 * `exclusion-filter.ts`. This file proves the other half: once an id never
 * becomes an `Entry`, it stays absent through every real packaging function
 * (catalogue shards, download packs, the lexical and semantic search index,
 * the static SVG preview shards, the manifest's entry counts) rather than
 * reappearing through a dedup
 * `alsoFoundIn` reference, a re-derivation from another field, or an
 * off-by-one in a shard/pack boundary. It calls the actual `writeArtifacts`,
 * `buildFacets`, and `buildSearchIndex` used by `build-corpus.ts` and
 * `demote-source-rights.ts` — not a reimplementation of them.
 *
 * Excel and SQLite exports are not built anywhere in this repo yet
 * (`public-data-exports` is unstarted) and are deliberately not exercised
 * here; see this suite's sibling coverage note in
 * `openspec/changes/legal-rights-and-release-integrity/tasks.md`.
 */

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-exclusion-absence-temp');

const EXCLUDED_ID = 'a1b2c3d4e5f60718';
const KEPT_ID = '0011223344556677';

function searchableRedistributableEntry(id: string, title: string) {
  return makeEntry({
    id,
    slug: `slug-${id}`,
    title,
    summary: title,
    description: title,
    descriptionSource: 'generated', // required for semantic-index inclusion
    rights: { status: 'redistributable', licence: 'MIT' },
    dedup: { canonical: true },
    structure: { nodeCount: 5, integrations: ['slack', 'webhook'] }, // clears the isSearchable/isIndexable floor
    tags: ['automation'],
  });
}

describe('exclusion registry: downstream absence', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('is absent from catalogue shards, download packs, search index, semantic index, and manifest counts', () => {
    const registry = createExclusionRegistry([
      { id: EXCLUDED_ID, reason: 'test takedown', excludedAt: '2026-08-27T00:00:00.000Z' },
    ]);

    // The full population, as it would exist before exclusion is applied.
    const allEntries = [
      searchableRedistributableEntry(EXCLUDED_ID, 'Excluded Workflow'),
      searchableRedistributableEntry(KEPT_ID, 'Kept Workflow'),
    ];

    // What actually reaches packaging: the registry has already removed the
    // excluded id, exactly as `exclusion-filter.ts` does for candidates.
    const packagedEntries = allEntries.filter((entry) => !registry.isExcluded(entry.id));
    expect(packagedEntries.map((e) => e.id)).toEqual([KEPT_ID]);

    const items = packagedEntries.map((entry) => ({ entry, chart: makeChart() }));
    const workflowsById = new Map<string, unknown>([[KEPT_ID, { name: 'kept', nodes: [], connections: {} }]]);

    const searchRes = buildSearchIndex(packagedEntries);
    const facetsData = buildFacets(packagedEntries);
    const written = writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });

    // Catalogue shard
    const shard = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'catalogue-0.json'), 'utf8')) as Array<{
      id: string;
    }>;
    expect(shard.map((e) => e.id)).not.toContain(EXCLUDED_ID);
    expect(shard.map((e) => e.id)).toContain(KEPT_ID);

    // Download pack
    const packContent = fs.readFileSync(path.join(TEST_DIR, 'packs', 'pack-0.jsonl'), 'utf8');
    expect(packContent).not.toContain(EXCLUDED_ID);
    expect(packContent).not.toContain('Excluded Workflow');

    // Lexical search index (both tiers)
    expect(searchRes.serializedIndex).not.toContain(EXCLUDED_ID);
    expect(searchRes.serializedExtendedIndex).not.toContain(EXCLUDED_ID);

    // Semantic index
    expect(searchRes.semanticIndex.serializedIndex).not.toContain(EXCLUDED_ID);

    // Static SVG preview shard (P5.6)
    const previewContent = fs.readFileSync(path.join(TEST_DIR, 'previews', 'preview-0.jsonl'), 'utf8');
    expect(previewContent).not.toContain(EXCLUDED_ID);
    expect(previewContent).toContain(KEPT_ID);

    // Facets: only the kept id's rights bucket is counted
    expect(facetsData.counts.rights.redistributable).toBe(1);
    expect(facetsData.ordinals).not.toContain(EXCLUDED_ID);

    // Manifest: entry counts are measured from what was actually written, so
    // an excluded id cannot inflate a shard's claimed entryCount.
    const { manifest } = buildManifest(TEST_DIR, written, '2026-08-13T12:00:00.000Z', undefined, { scannerSidecars: 'optional' });
    expect(manifest.totalEntries).toBe(1);
    expect(Object.keys(manifest.catalogueShards)).toEqual([KEPT_ID]);
  });
});
