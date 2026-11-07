import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { decideRights } from './decide.js';
import type { RightsEvidenceInput } from './evidence.js';

const DATA_DIR = path.join(process.cwd(), 'data');

/**
 * The RULING-2 boundary: an entry whose redistribution was removed for missing
 * per-item licence evidence must not get it back because a body turned up later.
 * Bodies are being re-acquired right now, so a body's arrival has to stay a
 * readiness event and never become a rights event.
 *
 * Two commits are cited, and they are different commits — the earlier draft of
 * the governing plan conflated them, which spec review caught:
 *
 *  - `a755b85` is the flip itself: all 288 rows whose `rights.status` was
 *    `redistributable` became `link_only` and their `download` coordinates were
 *    removed. This is the rights decision, and the voice it wrote is
 *    {@link RULING2_REASON}.
 *  - `6a05248` is the later P3-3 regeneration at which the emptied packs left
 *    the release inventory entirely (`packCount 2 -> 0`, zero download
 *    pointers). This is the pack removal, cited only in the packing half below.
 */
const RULING2_REASON =
  'no per-item licence evidence in the recorded commit - linked, not redistributed';

/** Shard-glob convention shared with `redistributable-body-inventory.test.ts`. */
function readCatalogueEntries(): Entry[] {
  const entries: Entry[] = [];
  for (let shard = 0; ; shard += 1) {
    const shardPath = path.join(DATA_DIR, `catalogue-${shard}.json`);
    if (!fs.existsSync(shardPath)) return entries;
    entries.push(...(JSON.parse(fs.readFileSync(shardPath, 'utf8')) as Entry[]));
  }
}

/** The 288 rows `a755b85` wrote that voice onto. */
const RULING2_ROWS = readCatalogueEntries().filter((entry) => entry.rights?.reason === RULING2_REASON);

/**
 * What acquisition records for a body it has just fetched: the commit the body
 * came from, and its digest. It records no licence instrument, because that is
 * the evidence the flip found missing — a body is not a licence.
 */
const BODY_ON_DISK: Partial<RightsEvidenceInput> = {
  sourceCommit: 'c'.repeat(40),
  bodyHash: 'b'.repeat(64),
};

/** The published four fields for one row, on one set of evidence. */
function rightsFor(row: Entry, evidence: Partial<RightsEvidenceInput>) {
  return decideRights({
    spdxId: row.rights?.licence ?? null,
    licenceUrl: row.rights?.licenceUrl ?? null,
    workflowPath: row.source?.path ?? '',
    sourceKind: row.source?.kind,
    evidence,
  }).rights;
}

describe('RULING-2 boundary: a re-acquired body changes readiness, never rights', () => {
  /**
   * The selector is the anchor. A regeneration that rewrote this voice would take
   * the set to zero and make every assertion below pass over an empty list, so
   * the count is asserted to be non-empty rather than pinned to a remembered 288
   * (the plan requires the figure be re-measured once the phases run, not
   * assumed). Failing here means re-point the anchor, not delete the test.
   */
  it('selects the flipped rows by the voice the flip wrote', () => {
    expect(RULING2_ROWS.length).toBeGreaterThan(0);
    expect(RULING2_ROWS.every((row) => row.rights?.status === 'link_only')).toBe(true);
    expect(RULING2_ROWS.every((row) => row.source?.kind === 'github')).toBe(true);
  });

  /**
   * The live half of the assertion. It exercises `decideRights` itself — the
   * branch that withholds redistribution when the identifier came from
   * repository metadata — with the body present and analysable, so it fails the
   * moment the decision starts treating a body as licence evidence.
   */
  it('keeps every flipped row link-only with the body present and analysable', () => {
    for (const row of RULING2_ROWS) {
      expect(rightsFor(row, BODY_ON_DISK).status).toBe('link_only');
    }
  });

  it('decides identically whether or not the body is present', () => {
    for (const row of RULING2_ROWS) {
      const withoutBody = rightsFor(row, { sourceCommit: BODY_ON_DISK.sourceCommit });
      expect(rightsFor(row, BODY_ON_DISK)).toEqual(withoutBody);
      expect(withoutBody.reason).toContain('metadata');
    }
  });

  /**
   * Positive control, and the reason the two cases above are a discriminator
   * rather than "everything is link-only": the same row and the same body become
   * redistributable the moment a same-commit licence instrument is recorded. The
   * discriminator is the licence evidence, not the body.
   */
  it('redistributes the same row once a same-commit licence instrument is recorded', () => {
    const row = RULING2_ROWS[0]!;
    const rights = rightsFor(row, {
      ...BODY_ON_DISK,
      licenceBasis: 'same-commit-file',
      rootLicence: [{ filename: 'LICENSE', sha256: 'a'.repeat(64) }],
    });
    expect(rights.status).toBe('redistributable');
  });

  /**
   * The packing half. It passes trivially today and is NOT evidence that the
   * boundary holds: `6a05248` left the inventory with zero pack files and zero
   * download pointers (`packCount 2 -> 0`) because RULING-2 left zero
   * redistributable rows, so the pack writer writes nothing for anyone,
   * link-only or not. Same vacuity class as the one recorded in
   * `pipeline/package/rights-count-population.test.ts`. Kept because it regains
   * force if packing returns, when these two assertions become live ones.
   */
  it('leaves no download pointer on a flipped row, and the corpus has no pack to put one in', () => {
    expect(RULING2_ROWS.every((row) => row.download === undefined)).toBe(true);

    const stats = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8')) as {
      packCount: number;
      redistributableCount: number;
    };
    expect(stats.packCount).toBe(0);
    expect(stats.redistributableCount).toBe(0);
  });
});
