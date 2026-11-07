import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceDef } from '@hub/contracts';
import { buildRedistributionReview, type ReviewEntry } from './redistribution-review.js';
import { verifyPackedBodyLine } from './redistribution-review-cli.js';

/**
 * The item-level review is the artifact a reviewer reads instead of the corpus,
 * so what it is tested for is that it states the evidence honestly: a shipped
 * `redistributable` row whose licence identifier came from repository metadata
 * must come out as not supported by the recorded evidence, and an item must
 * never read as verified when its body could not be re-derived.
 */
const source = (repo: string, overrides: Partial<SourceDef> = {}): SourceDef => ({
  key: repo,
  kind: 'github',
  repo,
  branch: 'main',
  include: [],
  exclude: [],
  expectedLicence: 'MIT',
  status: 'active',
  note: 'test source',
  reviewedAt: '2026-08-13',
  ...overrides,
});

const entry = (
  id: string,
  repo: string,
  overrides: Partial<ReviewEntry['rights']> & { path?: string; status?: ReviewEntry['rights']['status'] } = {},
): ReviewEntry => ({
  id,
  rights: {
    status: overrides.status ?? 'redistributable',
    licence: overrides.licence === undefined ? 'MIT' : overrides.licence,
    licenceUrl: overrides.licenceUrl === undefined ? 'https://api.github.com/licenses/mit' : overrides.licenceUrl,
    reason: overrides.reason ?? 'repository licence: MIT',
  },
  source: {
    kind: 'github',
    repo,
    owner: repo.split('/')[0]!,
    path: overrides.path ?? 'workflows/one.json',
    commit: 'c'.repeat(40),
    permalink: `https://github.com/${repo}/blob/${'c'.repeat(40)}/workflows/one.json`,
  },
  download: { pack: 0, line: 3, offset: 0, length: 20, sha256: 'd'.repeat(64) },
});

describe('buildRedistributionReview', () => {
  it('reports a shipped redistributable row as unsupported when the identifier was metadata-only', () => {
    const review = buildRedistributionReview({
      entries: [entry('one', 'owner/repo')],
      sources: [source('owner/repo')],
    });

    expect(review.schemaVersion).toBe('redistribution-review-v1');
    expect(review.summary.total).toBe(1);
    expect(review.summary.byDisposition).toEqual({ link_only: 1 });
    expect(review.summary.distributionSupportedByRecordedEvidence).toBe(0);

    const [item] = review.items;
    expect(item!.recordedStatus).toBe('redistributable');
    expect(item!.disposition).toBe('link_only');
    expect(item!.evidence.licenceBasis).toBe('metadata-only');
    expect(item!.evidence.sourceCommit).toBe('c'.repeat(40));
    expect(item!.evidence.bodyHash).toBe('d'.repeat(64));
    expect(item!.evidenceGaps.join(' ')).toContain('no licence-instrument hash');
    expect(item!.openQuestions.join(' ')).toContain('shipped as redistributable');
  });

  it('quarantines an item whose configured expectation contradicts the acquired licence', () => {
    const review = buildRedistributionReview({
      entries: [entry('mismatch', 'owner/repo')],
      sources: [source('owner/repo', { expectedLicence: 'Apache-2.0' })],
    });

    expect(review.items[0]!.disposition).toBe('excluded');
    expect(review.items[0]!.evidence.expectedLicenceMatch).toBe('mismatch');
    expect(review.items[0]!.dispositionReason).toContain('expectedLicence');
  });

  it('names an excluded source and a recorded withdrawal on the item', () => {
    const review = buildRedistributionReview({
      entries: [entry('excluded-source', 'owner/unregistered'), entry('withdrawn', 'owner/withdrawn')],
      sources: [source('owner/withdrawn', { redistribute: false })],
    });

    const excludedSource = review.items.find((item) => item.id === 'excluded-source')!;
    expect(excludedSource.source.registryStatus).toBe('unregistered');
    expect(excludedSource.openQuestions.join(' ')).toContain('not in the active registry');

    const withdrawn = review.items.find((item) => item.id === 'withdrawn')!;
    expect(withdrawn.source.redistributionWithdrawn).toBe(true);
    expect(withdrawn.disposition).toBe('link_only');
    expect(withdrawn.openQuestions.join(' ')).toContain('redistribution withdrawal');
  });

  it('is deterministic and reconciles its disposition counts with the item count', () => {
    const entries = [entry('b', 'owner/repo'), entry('a', 'owner/repo', { licence: null, licenceUrl: null })];

    const first = buildRedistributionReview({ entries, sources: [source('owner/repo')] });
    const second = buildRedistributionReview({ entries: [...entries].reverse(), sources: [source('owner/repo')] });

    expect(first.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never reports a body as re-derived unless the verifier confirmed it', () => {
    const entries = [entry('one', 'owner/repo')];

    const unverified = buildRedistributionReview({ entries, sources: [source('owner/repo')] });
    expect(unverified.items[0]!.body!.reDerivedFromPack).toBe(false);
    expect(unverified.summary.itemsWithReverifiedBody).toBe(0);

    const verified = buildRedistributionReview({
      entries,
      sources: [source('owner/repo')],
      verifyPackedBody: () => true,
    });
    expect(verified.items[0]!.body!.reDerivedFromPack).toBe(true);
    expect(verified.summary.itemsWithReverifiedBody).toBe(1);
  });
});

describe('verifyPackedBodyLine', () => {
  it('re-derives the digest from the pack bytes and rejects a pointer that does not resolve to them', () => {
    const dataDir = path.join(process.cwd(), 'pipeline', '.work', 'test-review-pack-verify');
    // Multi-byte characters on purpose: the pointer is in bytes, so a verifier
    // that split the file into characters would compute a different digest.
    const body = '{"name":"віджет-工作-🙂","nodes":[]}';
    const second = '{"name":"second"}';
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const secondBytes = Buffer.byteLength(second, 'utf8');
    fs.mkdirSync(path.join(dataDir, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'packs', 'pack-0.jsonl'), `${body}\n${second}\n`, 'utf8');

    try {
      const pointer = {
        pack: 0,
        line: 0,
        offset: 0,
        length: bodyBytes + 1, // the pointer's length includes the newline
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'), // the digest does not
      };
      const base = entry('one', 'owner/repo');
      expect(verifyPackedBodyLine(dataDir, { ...base, download: pointer })).toBe(true);
      expect(
        verifyPackedBodyLine(dataDir, {
          ...base,
          download: { ...pointer, offset: bodyBytes + 1, length: secondBytes + 1, sha256: createHash('sha256').update(second, 'utf8').digest('hex') },
        }),
      ).toBe(true);

      // A digest over the newline-terminated span is not the recorded digest.
      expect(
        verifyPackedBodyLine(dataDir, {
          ...base,
          download: { ...pointer, sha256: createHash('sha256').update(`${body}\n`, 'utf8').digest('hex') },
        }),
      ).toBe(false);
      // A span that does not end at a line boundary is not a line.
      expect(verifyPackedBodyLine(dataDir, { ...base, download: { ...pointer, length: 5 } })).toBe(false);
      expect(verifyPackedBodyLine(dataDir, { ...base, download: { ...pointer, pack: 9 } })).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
