import { describe, expect, test } from 'vitest';
import { resultsDigest } from './scanner-result-digest.mjs';
import {
  auditScannerResultFreshness,
  readScannerVersionFromSource,
  SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION,
} from './scanner-result-freshness.mjs';

/**
 * The shipped catalogue carries 11,464 security verdicts about code we did not
 * write. Nothing tied them to the scanner that produced them, so a scanner
 * change could leave grades behind with every gate green. These tests pin the
 * three things the binding has to do: name the identity it recorded, refuse a
 * scanner that no longer matches it, and refuse to treat the 11,176 link-only
 * verdicts as verified when no authorized body exists to rescan.
 */
const entry = (id, status, overrides = {}, entryOverrides = {}) => ({
  id,
  rights: { status },
  source: { kind: 'github' },
  // The published marker for how the readiness report was produced. `b` is the
  // link-only entry with no body, so it is the one the record must count as
  // unscanned and unverified.
  readiness: { analysis: 'derived' },
  download: status === 'redistributable' ? { pack: 0, line: 0, offset: 0, length: 10, sha256: 'a'.repeat(64) } : undefined,
  security: {
    grade: 'LOW',
    score: 10,
    counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion: 'c998701',
    profile: 'beta-default',
    schemaVersion: 'scanner-result-v1',
    ...overrides,
  },
  ...entryOverrides,
});

const entries = [
  entry('a', 'redistributable'),
  entry('b', 'link_only', {}, { readiness: { analysis: 'unscanned' } }),
  entry('c', 'redistributable'),
];

const record = (overrides = {}) => ({
  schemaVersion: SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION,
  scannerVersion: 'scanner-beta-1',
  profile: 'beta-default',
  resultsDigest: resultsDigest(entries),
  recordedResultStamps: [{ value: 'c998701', kind: 'git-commit-abbreviation', meaning: 'last commit touching the scanner directory at build time' }],
  scope: { total: 3, redistributable: 2, linkOnly: 1, searchable: 2 },
  rescan: { bodies: 2, identical: 1, different: 1, differentIds: ['a'], cause: 'policy change' },
  unverified: [{ scope: 'link_only', count: 1, status: 'unverified', reason: 'no authorized body reacquired' }],
  derivation: {
    verified: { status: 'verified', count: 2, reason: 're-derived from an authorized body' },
    unscanned: {
      status: 'unscanned',
      reason: 'no workflow JSON was available for analysis',
      count: 1,
      byScope: { official_without_body: 0, community_link_only_without_body: 1 },
    },
  },
  ...overrides,
});

const audit = (overrides = {}) =>
  auditScannerResultFreshness({
    entries,
    record: record(overrides),
    currentScannerVersion: 'scanner-beta-1',
    manifestScannerVersion: 'c998701',
    searchableCount: 2,
  });

describe('readScannerVersionFromSource', () => {
  test('reads the declared engine identity', () => {
    expect(readScannerVersionFromSource("export const SCANNER_VERSION = 'scanner-beta-1' as const;\n")).toBe('scanner-beta-1');
  });

  test('returns null rather than guessing when the constant is absent', () => {
    expect(readScannerVersionFromSource('export const SCANNER_VERSION = SCANNER_VERSION_FROM_ENV;')).toBeNull();
  });
});

describe('auditScannerResultFreshness', () => {
  test('accepts a record whose identity matches the scanner and reports what it compared', () => {
    const { violations, report } = audit();
    expect(violations).toEqual([]);
    expect(report).toContainEqual(['scanner version', "recorded 'scanner-beta-1' == current 'scanner-beta-1'"]);
    expect(report.flat().join(' ')).toMatch(/c998701/);
    expect(report.flat().join(' ')).toMatch(/1 link-only results/u);
  });

  test('fails when the recorded identity is not the scanner on disk', () => {
    const { violations } = audit({ scannerVersion: 'scanner-beta-0' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("recorded scanner version 'scanner-beta-0'");
    expect(violations[0]).toContain("current scanner 'scanner-beta-1'");
  });

  test('fails when the results carry a stamp the record does not declare', () => {
    const { violations } = audit({ recordedResultStamps: [] });
    expect(violations).toEqual([
      "scanner-result freshness: undeclared result stamp 'c998701' on a",
      expect.stringContaining('metadata.scannerVersion'),
    ]);
  });

  test('fails when the manifest stamp alone is undeclared, with every catalogue entry declared', () => {
    // The manifest carries its own copy of the stamp, and it is the value a
    // reader sees without opening a shard. Checking it only when a catalogue
    // entry happens to share it would let this exact edit through.
    const { violations, report } = auditScannerResultFreshness({
      entries,
      record: record(),
      currentScannerVersion: 'scanner-beta-1',
      manifestScannerVersion: 'deadbee',
      searchableCount: 2,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("data/manifest.json metadata.scannerVersion is 'deadbee'");
    expect(violations[0]).toContain("current scanner 'scanner-beta-1'");
    expect(violations[0]).toContain('c998701');
    expect(report).toContainEqual(['manifest stamp', 'deadbee (undeclared)']);
  });

  test('accepts a manifest stamp that is the current scanner identity', () => {
    const { violations, report } = auditScannerResultFreshness({
      entries,
      record: record(),
      currentScannerVersion: 'scanner-beta-1',
      manifestScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    expect(violations).toEqual([]);
    expect(report).toContainEqual(['manifest stamp', 'scanner-beta-1 (matches the current scanner identity)']);
  });

  test('fails when the shipped verdicts changed without the record being regenerated', () => {
    const { violations } = audit({ resultsDigest: `sha256:${'0'.repeat(64)}` });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/results changed without regenerating the record/u);
  });

  test('fails when a profile or a download pointer no longer matches the shipped results', () => {
    const changed = entries.map((item) => (item.id === 'a' ? { ...item, security: { ...item.security, profile: 'beta-hardened' } } : item));
    const noPointer = entries.map((item) => (item.id === 'c' ? { ...item, download: undefined } : item));
    const withProfile = auditScannerResultFreshness({
      entries: changed,
      record: record({ resultsDigest: resultsDigest(changed) }),
      currentScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    const withoutPointer = auditScannerResultFreshness({
      entries: noPointer,
      record: record({ resultsDigest: resultsDigest(noPointer) }),
      currentScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    expect(withProfile.violations.join(' ')).toMatch(/profile "beta-default" does not match/u);
    expect(withoutPointer.violations.join(' ')).toMatch(/redistributable entries carry no download pointer/u);
  });

  test('fails when either total stops reconciling', () => {
    expect(audit({ scope: { total: 3, redistributable: 2, linkOnly: 0, searchable: 2 } }).violations.join(' '))
      .toMatch(/scope\.linkOnly is 0, measured 1/u);
    expect(audit({ scope: { total: 3, redistributable: 2, linkOnly: 1, searchable: 11245 } }).violations.join(' '))
      .toMatch(/scope\.searchable is 11245, measured 2/u);
  });

  test('fails when link-only results are claimed verified or left out', () => {
    expect(audit({ unverified: [] }).violations.join(' ')).toMatch(/not marked unverified/u);
    expect(audit({ unverified: [{ scope: 'link_only', count: 1, status: 'verified', reason: 'r' }] }).violations.join(' '))
      .toMatch(/marked "verified", expected 'unverified'/u);
    expect(audit({ unverified: [{ scope: 'link_only', count: 1, status: 'unverified' }] }).violations.join(' '))
      .toMatch(/has no reason/u);
  });

  test('reports what each entry says about how its facts were produced', () => {
    const { violations, report } = audit();
    expect(violations).toEqual([]);
    expect(report).toContainEqual([
      'derivation',
      '2 entries re-derived from an authorized body; 1 with no workflow JSON (0 official, 1 community link-only)',
    ]);
  });

  test('fails when an entry publishes no readiness analysis marker at all', () => {
    // No marker is the false-clean state: an empty credential list with nothing
    // to qualify it reads as "this workflow needs no credentials".
    const unmarked = [entry('a', 'redistributable', {}, { readiness: {} }), ...entries.slice(1)];
    const { violations } = auditScannerResultFreshness({
      entries: unmarked,
      record: record({ resultsDigest: resultsDigest(unmarked) }),
      currentScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    expect(violations.join(' ')).toMatch(/no readiness\.analysis marker/u);
    expect(violations.join(' ')).toMatch(/note\): a /u);
  });

  test('fails when the recorded derivation counts do not match the artifacts', () => {
    const verified = audit({ derivation: { ...record().derivation, verified: { status: 'verified', count: 3, reason: 'r' } } });
    expect(verified.violations.join(' ')).toMatch(/derivation\.verified is "verified"\/3, measured 2/u);
    const unscanned = audit({ derivation: { ...record().derivation, unscanned: { ...record().derivation.unscanned, count: 0 } } });
    expect(unscanned.violations.join(' ')).toMatch(/derivation\.unscanned is "unscanned"\/0, measured 1/u);
    const status = audit({ derivation: { ...record().derivation, unscanned: { ...record().derivation.unscanned, status: 'verified' } } });
    expect(status.violations.join(' ')).toMatch(/derivation\.unscanned is "verified"/u);
  });

  test('fails when the unscanned breakdown does not name the scopes it counted', () => {
    const badScope = audit({
      derivation: { ...record().derivation, unscanned: { ...record().derivation.unscanned, byScope: { official_without_body: 1, community_link_only_without_body: 0 } } },
    });
    expect(badScope.violations.join(' ')).toMatch(/official_without_body is 1, measured 0/u);
    const noReason = audit({ derivation: { ...record().derivation, unscanned: { ...record().derivation.unscanned, reason: '' } } });
    expect(noReason.violations.join(' ')).toMatch(/derivation\.unscanned has no stated reason/u);
  });

  test('fails when a link-only entry is left out of the unverified set', () => {
    expect(audit({ unverified: [{ scope: 'link_only', count: 0, status: 'unverified', reason: 'r' }] }).violations.join(' '))
      .toMatch(/unverified link-only count is 0, measured 1 link-only entries with no workflow JSON/u);
  });

  test('fails when the record has no derivation block at all', () => {
    const { violations } = audit({ derivation: undefined });
    expect(violations.join(' ')).toMatch(/no derivation coverage block/u);
  });

  test('fails when the recorded rescan does not reconcile', () => {
    expect(audit({ rescan: { bodies: 2, identical: 2, different: 1, differentIds: ['a'], cause: 'c' } }).violations.join(' '))
      .toMatch(/rescan evidence does not reconcile/u);
    expect(audit({ rescan: { bodies: 2, identical: 2, different: 0, differentIds: ['a'] } }).violations.join(' '))
      .toMatch(/difference ids do not match/u);
    expect(audit({ rescan: { bodies: 2, identical: 1, different: 1, differentIds: ['zz'], cause: 'c' } }).violations.join(' '))
      .toMatch(/names 1 id\(s\) absent from the catalogue/u);
  });

  /**
   * After the RULING-2 flip there is no redistributable row left, so
   * `boundResults(entries)` is empty and `profiles` is the empty set. The old
   * `profiles.size !== 1` test was then unsatisfiable — no declared profile
   * could match an empty set, and no data edit could pass it. The check's intent
   * is "every shipped result carries the profile the record declares", which is
   * vacuously true when nothing is shipped; the gate must say so, not fail.
   */
  test('accepts a corpus with no redistributable results, where the profile check is vacuous', () => {
    const linkOnly = [entry('only', 'link_only', {}, { readiness: { analysis: 'unscanned' } })];
    const { violations, report } = auditScannerResultFreshness({
      entries: linkOnly,
      record: {
        schemaVersion: SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION,
        scannerVersion: 'scanner-beta-1',
        profile: 'beta-default',
        resultsDigest: resultsDigest(linkOnly),
        recordedResultStamps: [{ value: 'c998701', kind: 'git-commit-abbreviation', meaning: 'm' }],
        scope: { total: 1, redistributable: 0, linkOnly: 1, searchable: 0 },
        rescan: { bodies: 0, identical: 0, different: 0, differentIds: [], cause: 'link-only flip' },
        unverified: [{ scope: 'link_only', count: 1, status: 'unverified', reason: 'no authorized body' }],
        derivation: {
          verified: { status: 'verified', count: 0, reason: 'no redistributable body remains' },
          unscanned: { status: 'unscanned', reason: 'no workflow JSON was available for analysis', count: 1, byScope: { official_without_body: 0, community_link_only_without_body: 1 } },
        },
      },
      currentScannerVersion: 'scanner-beta-1',
      manifestScannerVersion: 'c998701',
      searchableCount: 0,
    });
    expect(violations).toEqual([]);
    expect(report).toContainEqual(['profile', 'no redistributable results to bind — profile "beta-default" not exercised']);
  });

  /**
   * The vacuous branch keys off "nothing bound", never off "no profile string
   * found": a bound result whose `security.profile` is absent, null or numeric
   * yields the same empty profile set as an empty corpus, and the pre-flip
   * expression refused all three. Only the corpus being empty may take the
   * vacuous branch; these stay violations.
   */
  test.each([
    ['absent', ({ profile, ...rest }) => rest],
    ['null', (security) => ({ ...security, profile: null })],
    ['numeric', (security) => ({ ...security, profile: 7 })],
  ])('still fails when a bound result carries a %s profile', (_label, malformedSecurity) => {
    const malformed = entries.map((item) =>
      item.rights.status === 'redistributable' ? { ...item, security: malformedSecurity(item.security) } : item,
    );
    const { violations, report } = auditScannerResultFreshness({
      entries: malformed,
      record: record({ resultsDigest: resultsDigest(malformed) }),
      currentScannerVersion: 'scanner-beta-1',
      manifestScannerVersion: 'c998701',
      searchableCount: 2,
    });
    expect(violations.join(' ')).toMatch(/record profile "beta-default" does not match the shipped profiles \[\]/u);
    expect(report.flat().join(' ')).not.toMatch(/no redistributable results to bind/u);
  });

  test('still fails when bound results exist and their profiles disagree with the record', () => {
    // The generalization must not swallow the cases it was meant to keep: a
    // single shipped profile that is not the declared one (size === 1 but the
    // record's profile is missing from the set), and two shipped results that
    // disagree with each other (size !== 1), both remain violations.
    const bothWrong = entries.map((item) => (item.rights.status === 'redistributable' ? { ...item, security: { ...item.security, profile: 'beta-hardened' } } : item));
    const single = auditScannerResultFreshness({
      entries: bothWrong,
      record: record({ resultsDigest: resultsDigest(bothWrong) }),
      currentScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    expect(single.violations.join(' ')).toMatch(/record profile "beta-default" does not match the shipped profiles \["beta-hardened"\]/u);

    const splitProfiles = entries.map((item) => (item.id === 'c' ? { ...item, security: { ...item.security, profile: 'beta-hardened' } } : item));
    const split = auditScannerResultFreshness({
      entries: splitProfiles,
      record: record({ resultsDigest: resultsDigest(splitProfiles) }),
      currentScannerVersion: 'scanner-beta-1',
      searchableCount: 2,
    });
    expect(split.violations.join(' ')).toMatch(/record profile "beta-default" does not match the shipped profiles \["beta-default","beta-hardened"\]/u);
  });

  test('still passes when bound results exist and agree with the record', () => {
    const { violations, report } = audit();
    expect(violations).toEqual([]);
    expect(report).toContainEqual(['profile', 'shipped profile "beta-default" matches the record']);
  });

  test('fails closed when there is no record at all', () => {
    expect(auditScannerResultFreshness({ entries, currentScannerVersion: 'scanner-beta-1' }).violations)
      .toEqual(['scanner-result freshness: no freshness record']);
  });
});
