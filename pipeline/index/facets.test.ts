import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import {
  buildFacets,
  countSetBits,
  decodeBase64ToUint32Array,
  intersectUint32Arrays,
} from './facets.js';

function makeDummyEntry(id: string, index: number): Entry {
  const grade = index % 3 === 0 ? 'LOW' : index % 3 === 1 ? 'MEDIUM' : 'HIGH';
  const trigger = index % 2 === 0 ? 'Webhook' : 'Schedule';
  const hasCode = index % 4 === 0;
  const hasAI = index % 5 === 0;

  return makeEntry({
    id,
    slug: `slug-${id}`,
    title: `Workflow ${id}`,
    summary: `Summary ${id}`,
    description: `Desc ${id}`,
    descriptionSource: 'upstream',
    source: {
      kind: 'github',
      repo: 'o/r',
      path: 'p.json',
      commit: '1234567890123456789012345678901234567890',
      author: { name: 'a' },
    },
    rights: { status: 'redistributable', licence: 'MIT' },
    structure: {
      nodeCount: 5,
      connectionCount: 4,
      nodeTypes: ['n8n-nodes-base.httpRequest'],
      integrations: ['slack'],
      trigger,
      complexity: 'simple',
      hasCode,
      hasAI,
      hasWebhook: trigger === 'Webhook',
    },
    security: {
      grade,
      score: 90,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
      scannerVersion: '1.0.0',
      profile: 'beta-default',
    },
    tags: [index % 2 === 0 ? 'openai' : 'slack', `tag-${index % 70}`],
    dedup: { fingerprint: `fp-${id}`, structuralHash: `sh-${id}`, canonical: true, alsoFoundIn: [] },
  });
}

describe('facets', () => {
  it('precomputes facet counts and bitsets', () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeDummyEntry(`entry-${i}`, i));
    const facets = buildFacets(entries);

    expect(facets.total).toBe(100);
    expect(facets.counts.rights).toEqual({ redistributable: 100 });
    expect(facets.counts.grade.LOW).toBe(34);
    expect(facets.counts.trigger.webhook).toBe(50);
    expect(facets.counts.trigger.schedule).toBe(50);

    const redistributableB64 = facets.bitsets['rights:redistributable'];
    expect(redistributableB64).toBeDefined();

    const redistributableBitset = decodeBase64ToUint32Array(redistributableB64!);
    expect(countSetBits(redistributableBitset)).toBe(100);
  });

  /**
   * The ordinal list used to ship inside `semantic-index.json`, where it agreed
   * with these bitsets only because two modules happened to iterate the same
   * array in the same order — a coincidence, held in two places. Co-generating
   * it here makes the agreement structural, and lets the 1.55 MB semantic index
   * be fetched lazily: the worker needs ordinals at init and must not need that
   * download to get them.
   */
  it('emits ordinals in the order the bitsets are indexed by', () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeDummyEntry(`entry-${i}`, i));
    const facets = buildFacets(entries);

    expect(facets.ordinals).toHaveLength(facets.total);
    expect(new Set(facets.ordinals).size).toBe(100);

    // Quality-ranked, not input order — the same sort decides which entries get
    // their full text indexed, so the two must not be allowed to diverge.
    // makeDummyEntry grades index%3: 0 LOW, 1 MEDIUM, 2 HIGH. Every LOW-grade
    // entry must therefore precede every HIGH-grade one.
    const positionOf = (predicate: (index: number) => boolean) =>
      facets.ordinals.map((id) => Number(id.replace('entry-', ''))).flatMap((n, at) => (predicate(n) ? [at] : []));
    const low = positionOf((n) => n % 3 === 0);
    const high = positionOf((n) => n % 3 === 2);
    expect(Math.max(...low)).toBeLessThan(Math.min(...high));

    // Every id set in the `trigger:webhook` bitset must be a webhook entry at
    // that same ordinal — this is the invariant the two used to satisfy only
    // by luck.
    const webhook = decodeBase64ToUint32Array(facets.bitsets['trigger:webhook']!);
    const flagged = facets.ordinals.filter((_, index) => (webhook[index >> 5]! & (1 << (index & 31))) !== 0);
    expect(flagged).toHaveLength(50);
    // makeDummyEntry gives even indices the Webhook trigger.
    expect(flagged.every((id) => Number(id.replace('entry-', '')) % 2 === 0)).toBe(true);
  });

  it('caps tags at top 60 by frequency', () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeDummyEntry(`entry-${i}`, i));
    const facets = buildFacets(entries);

    const tagCountKeys = Object.keys(facets.counts.tags);
    expect(tagCountKeys.length).toBeLessThanOrEqual(60);
    expect(facets.counts.tags.openai).toBeDefined();
    expect(facets.counts.tags.slack).toBeDefined();
    expect(facets.bitsets['tag:tag-69']).toBeDefined();
  });

  it('intersects bitsets for combined filtering', () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeDummyEntry(`entry-${i}`, i));
    const facets = buildFacets(entries);

    const redistB64 = facets.bitsets['rights:redistributable']!;
    const webhookB64 = facets.bitsets['trigger:webhook']!;

    const redistBits = decodeBase64ToUint32Array(redistB64);
    const webhookBits = decodeBase64ToUint32Array(webhookB64);

    const intersection = intersectUint32Arrays([redistBits, webhookBits]);
    const setBitCount = countSetBits(intersection);

    let manualCount = 0;
    for (let i = 0; i < 100; i++) {
      if (entries[i]?.rights.status === 'redistributable' && entries[i]?.structure.trigger === 'Webhook') {
        manualCount++;
      }
    }

    expect(setBitCount).toBe(manualCount);
  });

  it('uses the shared indexable corpus as its denominator and keeps complete filter bitsets', () => {
    const visible = makeDummyEntry('visible', 0);
    visible.structure.integrations = ['Google Sheets'];
    visible.tags = ['Daily Digest'];
    visible.structure.trigger = 'Webhook';
    visible.structure.hasCode = true;
    // A duplicate, not a fallback description. An entry whose prose could not
    // be generated is still findable by title, tags and integrations — search
    // membership is about structure and canonicality, not about whether the
    // description generator happened to produce something.
    const hidden = makeDummyEntry('hidden', 1);
    hidden.dedup.canonical = false;
    hidden.structure.integrations = ['Slack'];

    const facets = buildFacets([visible, hidden]);

    expect(facets.total).toBe(1);
    expect(facets.counts.integrations).toEqual({ 'google-sheets': 1 });
    expect(facets.counts.trigger).toEqual({ webhook: 1 });
    expect(facets.counts.capabilities).toMatchObject({ code: 1, webhook: 1 });
    expect(facets.counts.tags).toEqual({ 'daily-digest': 1 });
    expect(facets.bitsets['integration:google-sheets']).toBeDefined();
    expect(facets.bitsets['tag:daily-digest']).toBeDefined();
    expect(facets.bitsets['capability:code']).toBeDefined();
    expect(facets.facets).toContainEqual({ slug: 'webhook', label: 'Webhook', group: 'trigger', count: 1 });
  });

  /**
   * Link-only entries used to be excluded here, because search membership was
   * gated on redistribution rights — which hid 11,180 analysed workflows from a
   * catalogue that had scanned every one of them. Being findable is not
   * republishing; `src/catalogue/download.ts` still holds the rights gate, and
   * a `rights` facet is only useful if both values are in it.
   *
   * A legacy `indexable` field on the entry is still ignored: it is an output
   * hint, never an input.
   */
  it('ignores legacy indexable overrides and counts link-only entries as findable', () => {
    const visible = makeDummyEntry('visible-contract', 0);
    const linkOnly = makeDummyEntry('link-only-rights', 1);
    linkOnly.rights.status = 'link_only';
    (visible as unknown as { indexable: boolean }).indexable = false;
    (linkOnly as unknown as { indexable: boolean }).indexable = true;

    const facets = buildFacets([visible, linkOnly]);

    expect(facets.total).toBe(2);
    expect(facets.counts.rights).toEqual({ redistributable: 1, link_only: 1 });
    expect(facets.bitsets['rights:link_only']).toBeDefined();
  });

  it('still excludes duplicates and entries below the structure floor', () => {
    const canonical = makeDummyEntry('canonical-entry', 0);
    const duplicate = makeDummyEntry('duplicate-entry', 1);
    duplicate.dedup.canonical = false;
    const tiny = makeDummyEntry('tiny-entry', 2);
    tiny.structure.nodeCount = 1;
    const bare = makeDummyEntry('bare-entry', 0);
    bare.structure.integrations = [];
    // The structure floor is stated on node types now, so an entry below it must
    // have no recognised node type — an entry without integrations is still
    // publishable and findable.
    bare.structure.nodeTypes = [];

    expect(buildFacets([canonical, duplicate, tiny, bare]).total).toBe(1);
  });
});
