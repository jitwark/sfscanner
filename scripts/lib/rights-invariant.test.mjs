import { describe, expect, it } from 'vitest';

import { auditRightsInvariant, downloadSpecGap } from './rights-invariant.mjs';

/**
 * The branch proof for the per-entry download precondition.
 *
 * The shipped corpus has zero redistributable entries, so `npm run
 * check:rights-invariant` never enters any of these branches against real data:
 * it can only report that no body travels with a link-only record. These
 * synthetic entries are the only place the precondition is exercised, and the
 * baseline is what makes a mutation meaningful — a check that rejects
 * everything would pass every mutation and fail this file.
 *
 * `line: 3` is entry line 3 because `download.ts` indexes the manifest's
 * `offsets`/`lengths` arrays by `download.line`, and the CLI packs the same
 * shape into the manifest it passes here.
 */
const MAX_FALLBACK_BYTES = 32 * 1024 * 1024;
const manifest = {
  artifacts: [{ path: 'packs/pack-0.jsonl', byteSize: 4096, offsets: [0, 0, 0, 100], lengths: [0, 0, 0, 20] }],
};
const entry = (download) => ({ id: 'wf-1', rights: { status: 'redistributable' }, download });
const evidence = [
  {
    id: 'wf-1',
    status: 'redistributable',
    evidence: { licenceBasis: 'same-commit-file', rootLicence: [{ filename: 'LICENSE', sha256: 'a'.repeat(64) }] },
  },
];

const audit = (download, extra = {}) =>
  auditRightsInvariant({
    entries: [entry(download)],
    packWorkflowIds: ['wf-1'],
    evidenceRecords: evidence,
    journalPath: null,
    manifest,
    maxFallbackBytes: MAX_FALLBACK_BYTES,
    ...extra,
  }).violations.join('\n');

const valid = { pack: 0, line: 3, offset: 100, length: 20, sha256: 'b'.repeat(64) };

describe('rights invariant download precondition', () => {
  it('accepts the baseline', () => {
    expect(audit(valid)).toBe('');
  });

  it.each([
    ['no download object', undefined, /without a download object/, undefined],
    ['non-hex sha256', { ...valid, sha256: 'xyz' }, /64-hex download\.sha256/, undefined],
    ['range beyond pack', { ...valid, offset: 4090, length: 20 }, /range exceeds the pack/, undefined],
    ['manifest offset mismatch', { ...valid, offset: 101 }, /manifest offset mismatch/, undefined],
    ['manifest length mismatch', { ...valid, length: 21 }, /manifest length mismatch/, undefined],
    ['pack above fallback bound', valid, /pack exceeds the fallback bound/, { maxFallbackBytes: 1024 }],
  ])('%s', (_name, download, expected, extra) => {
    expect(audit(download, extra)).toMatch(expected);
  });

  it('names the pack the manifest does not declare', () => {
    expect(audit({ ...valid, pack: 7 })).toMatch(/packs\/pack-7\.jsonl is not declared in the release manifest/);
  });

  it('reports a missing manifest rather than dereferencing it', () => {
    expect(downloadSpecGap(entry(valid), null, MAX_FALLBACK_BYTES)).toMatch(/is not declared in the release manifest/);
  });
});
