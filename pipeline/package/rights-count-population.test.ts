import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSearchable, type Entry } from '@hub/contracts';
import { makeChart, makeEntry } from '../__fixtures__/make-entry.js';
import { buildSearchIndex } from '../index/build-search-index.js';
import { buildFacets } from '../index/facets.js';
import { writeArtifacts } from './write-artifacts.js';

/**
 * Regression fixture for the "288 vs. 287" defect
 * (`openspec/changes/legal-rights-and-release-integrity/design.md`, "The
 * 288-vs-287 defect"; live at `data/stats.json` as of 2026-08-27:
 * `redistributableCount: 288`, `facetCounts.rights.redistributable: 287`).
 *
 * Root cause, traced against the real production data: `stats.json`'s
 * top-level `redistributableCount` (`write-artifacts.ts`) is measured over
 * every entry with `rights.status === 'redistributable'`, full stop.
 * `facetCounts.rights` (`facets.ts`'s `buildFacets`) is measured only over
 * `rankedSearchableEntries` — canonical entries that also clear the
 * `isSearchable` quality floor (`nodeCount >= 3` and at least one
 * integration). One canonical, genuinely redistributable, genuinely
 * downloadable production entry (`3846222b18db92f3`, a 2-node workflow) fails
 * that floor, so it counts toward the top-level figure but not the facet.
 *
 * This is NOT the same population by design — `facets.ts` shares one bitset
 * ordinal space across all seven facet groups (rights, grade, trigger,
 * complexity, capability, integration, tag), so giving "rights" alone a
 * wider population than the other six would require a second, unindexed
 * bitset space. And collapsing `redistributableCount` down to the facet
 * population would undercount a file that is genuinely in the download packs
 * today — `README.md`'s doc-gated "Redistributable (JSON downloadable)" line is
 * the corpus-wide count, not the search-facet count. Since audit F-001 RULING-2
 * moved the last 288 redistributable rows to link-only on 2026-09-27 and cleared
 * their download pointers, both sides of that gap are now 0, so this assertion is
 * trivially satisfied today; it regains its force the moment any redistributable
 * row with a body returns, which is exactly when it matters.
 *
 * So rather than forcing bit-for-bit equality (which `openspec/changes/
 * legal-rights-and-release-integrity/specs/rights-and-exclusion-registry/
 * spec.md`'s "Rights Count Population Consistency" requirement asks for
 * literally, with no carve-out — flagged back to the spec, not resolved
 * unilaterally here), this pins the *explained* relationship: the gap
 * between the two counts must equal exactly the number of canonical
 * redistributable entries excluded by the search-quality floor. If that gap
 * ever changes without a matching change to `isSearchable`'s floor, this
 * fails — which is the real protection: a real leaked/missing exclusion, or a
 * new counting bug, would move the gap for a reason unrelated to the floor,
 * and this test would catch it instead of silently accepting a new gap size.
 */

const TEST_DIR = path.join(process.cwd(), 'pipeline', '.work', 'test-rights-count-population-temp');

function redistributableEntry(id: string, overrides: Partial<Entry['structure']> = {}): Entry {
  return makeEntry({
    id,
    slug: `slug-${id}`,
    rights: { status: 'redistributable', licence: 'MIT' },
    dedup: { canonical: true },
    structure: { nodeCount: 5, integrations: ['slack'], ...overrides },
  });
}

function linkOnlyEntry(id: string, overrides: Partial<Entry['structure']> = {}): Entry {
  return makeEntry({
    id,
    slug: `slug-${id}`,
    rights: { status: 'link_only' },
    dedup: { canonical: true },
    structure: { nodeCount: 5, integrations: ['slack'], ...overrides },
  });
}

describe('stats.json redistributableCount vs. facetCounts.rights.redistributable', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('diverges by exactly the count of redistributable entries the search-quality floor excludes', () => {
    const belowFloor = redistributableEntry('below-floor', { nodeCount: 2 }); // fails isSearchable
    const aboveFloor = redistributableEntry('above-floor'); // clears isSearchable
    const entries = [belowFloor, aboveFloor];

    expect(isSearchable(belowFloor)).toBe(false);
    expect(isSearchable(aboveFloor)).toBe(true);

    const items = entries.map((entry) => ({ entry, chart: makeChart() }));
    const workflowsById = new Map<string, unknown>(
      entries.map((entry) => [entry.id, { name: entry.id, nodes: [], connections: {} }]),
    );
    const searchRes = buildSearchIndex(entries);
    const facetsData = buildFacets(entries);

    writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });
    const stats = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'stats.json'), 'utf8'));

    const redistributableTotal = entries.filter((e) => e.rights.status === 'redistributable').length;
    const gateExcluded = entries.filter(
      (e) => e.rights.status === 'redistributable' && !isSearchable(e),
    ).length;

    expect(stats.redistributableCount).toBe(redistributableTotal); // 2: whole-corpus count, matches README
    expect(stats.facetCounts.rights.redistributable).toBe(1); // 1: search-quality-gated count
    expect(gateExcluded).toBe(1);
    expect(stats.redistributableCount - stats.facetCounts.rights.redistributable).toBe(gateExcluded);
  });

  it('agrees exactly when no redistributable entry fails the search-quality floor', () => {
    const entries = [redistributableEntry('one'), redistributableEntry('two')];
    const items = entries.map((entry) => ({ entry, chart: makeChart() }));
    const workflowsById = new Map<string, unknown>(
      entries.map((entry) => [entry.id, { name: entry.id, nodes: [], connections: {} }]),
    );
    const searchRes = buildSearchIndex(entries);
    const facetsData = buildFacets(entries);

    writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });
    const stats = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'stats.json'), 'utf8'));

    expect(stats.redistributableCount).toBe(2);
    expect(stats.facetCounts.rights.redistributable).toBe(2);
    expect(stats.redistributableCount).toBe(stats.facetCounts.rights.redistributable);
  });
});

/**
 * The live scope split, pinned on the side the corpus actually shows it.
 *
 * `stats.json` carries two rights figures over two populations, and one cannot
 * be read as the other:
 *
 * - `linkOnlyCount` = `totalEntries - redistributableCount`, **corpus-wide**.
 *   Today: 11,464 of 11,464 entries (every entry is link-only after RULING-2).
 * - `facetCounts.rights.link_only`, copied from `facetsData.counts`, measured
 *   over `rankedSearchableEntries` only. Today: 11,245.
 *
 * The 219-entry gap is the corpus entries the `isSearchable` floor
 * (`nodeCount >= 3`, one recognised node type, canonical) excludes. It is not
 * a defect in either number and neither is "reconciled" to the other:
 * `facets.ts` shares one bitset ordinal space across all seven facet groups,
 * so giving `rights` alone the corpus population would need a second,
 * unindexed bitset space, and collapsing `linkOnlyCount` to the search
 * population would undercount entries that are genuinely in the catalogue.
 *
 * Those figures are the current artifact's measured values, not constants a
 * future corpus keeps — so the fixture below asserts the *scopes* on two
 * entries rather than the two live numbers. If either side silently widens or
 * narrows (the facet starts counting the corpus, or the top-level count starts
 * counting only search rows), exactly one of these assertions moves.
 */
describe('stats.json linkOnlyCount vs. facetCounts.rights.link_only', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('counts 2 link-only entries corpus-wide and 1 in the search facet', () => {
    const excludedFromSearch = linkOnlyEntry('below-floor', { nodeCount: 2 }); // fails isSearchable
    const includedInSearch = linkOnlyEntry('above-floor'); // clears isSearchable
    const entries = [excludedFromSearch, includedInSearch];

    expect(isSearchable(excludedFromSearch)).toBe(false);
    expect(isSearchable(includedInSearch)).toBe(true);

    const items = entries.map((entry) => ({ entry, chart: makeChart() }));
    const workflowsById = new Map<string, unknown>(
      entries.map((entry) => [entry.id, { name: entry.id, nodes: [], connections: {} }]),
    );
    const searchRes = buildSearchIndex(entries);
    const facetsData = buildFacets(entries);

    writeArtifacts(items, workflowsById, searchRes, facetsData, TEST_DIR, { legacyV1: true });
    const stats = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'stats.json'), 'utf8'));

    // Corpus-wide: 11,464 today.
    expect(stats.linkOnlyCount).toBe(2);
    expect(stats.totalEntries).toBe(2);
    // Search-scoped: 11,245 today.
    expect(stats.facetCounts.rights.link_only).toBe(1);
    expect(facetsData.total).toBe(1);
    expect(stats.totalEntries - stats.facetCounts.rights.link_only).toBe(1);
  });
});
