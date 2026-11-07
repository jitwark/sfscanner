import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCoverageCensus, coverageCensusReconciles, serializeCoverageCensus } from './body-coverage-census';
import { TRIM_EQUIVALENCE_SCHEMA, type TrimEquivalenceProof } from './trim-equivalence-proof';

const fixture = fileURLToPath(new URL('./census-fixture', import.meta.url));
const sourceA = fileURLToPath(new URL('./census-fixture/bodies-a', import.meta.url));
const sourceB = fileURLToPath(new URL('./census-fixture/bodies-b', import.meta.url));

const options = { catalogueDirs: [fixture], bodyDirs: [sourceA, sourceB], idCutoff: 50 };

describe('official body coverage census', () => {
  it('classifies every unscanned official entry as recoverable or residual, counting each body once', () => {
    const census = buildCoverageCensus(options);

    expect(census.unscannedTotal).toBe(6);
    expect(census.officialUnscanned).toBe(5);
    expect(census.communityUnscanned).toBe(1);

    // 10 lives only in source A, 20 only in source B, 30 in both: each counts
    // once, and the earlier source owns the id it first supplied.
    expect(census.recoverable).toEqual([10, 20, 30, 40]);
    expect(census.perSource).toEqual([
      { dir: sourceA, bodyCount: 2, recovers: [10, 30], admissible: [10, 30], refusedKeys: [] },
      {
        dir: sourceB,
        bodyCount: 4,
        recovers: [20, 40],
        admissible: [20],
        refusedKeys: [
          { key: '_documentation', count: 1 },
          { key: '_security', count: 1 },
        ],
      },
    ]);

    // 100 has a body in no source at all: the honest residual, above the cutoff.
    expect(census.residual).toEqual([100]);
    expect(census.residualAboveCutoff).toBe(1);
    expect(census.cutoff).toBe(50);

    // The derived entry (below) and the body-less community entry stay off the official side.
    expect(census.recoverable.length + census.residual.length).toBe(census.officialUnscanned);
    expect(coverageCensusReconciles(census)).toEqual([]);
  });

  it('separates a body that exists from a body that may be used, naming what the rest carry', () => {
    const census = buildCoverageCensus(options);

    // 40 exists in source B, so it is recoverable; it carries the legacy
    // `_security` and `_documentation` blocks, so it is not admissible and the
    // entry it would supply stays unscanned.
    expect(census.recoverableAdmissible).toEqual([10, 20, 30]);
    expect(census.annotatedRecoverable).toEqual([40]);
    expect(census.recoverableAdmissible.length + census.annotatedRecoverable.length).toBe(census.recoverable.length);
  });

  it('refuses a census whose admissible and annotated halves do not add up to the recoverable set', () => {
    const census = buildCoverageCensus(options);
    expect(coverageCensusReconciles({ ...census, annotatedRecoverable: [] })).toEqual([
      'recoverableAdmissible 3 + annotatedRecoverable 0 != recoverable 4',
    ]);
  });

  it('ignores a body file whose name does not parse instead of guessing an id', () => {
    const census = buildCoverageCensus(options);
    // bodies-b holds five *.json files, one of which is `official__notanid_broken.json`.
    expect(census.perSource[1].bodyCount).toBe(4);
    expect(census.perSource[1].recovers).toEqual([20, 40]);
  });

  it('serializes deterministically and records the cutoff it was measured against', () => {
    const first = serializeCoverageCensus(buildCoverageCensus(options));
    const second = serializeCoverageCensus(buildCoverageCensus(options));
    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 'official-body-coverage-census-v1',
      cutoff: 50,
      recoverableAdmissible: [10, 20, 30],
      annotatedRecoverable: [40],
    });
  });
});

/** The shape `assessTrimProof` needs before it can permit anything, scoped to the fixture's second folder. */
function trimProof(overrides: Partial<TrimEquivalenceProof> = {}): TrimEquivalenceProof {
  return {
    schemaVersion: TRIM_EQUIVALENCE_SCHEMA,
    curatedDir: sourceA,
    masterDir: sourceB,
    pairsCompared: 1,
    canonicalMatches: 1,
    rawByteMatches: 1,
    formatOnlyMatches: 0,
    contentMismatchIds: [],
    sampleMismatches: [],
    removedKeyHistogram: [{ key: '_documentation', count: 1 }],
    encoderFidelity: { curatedRoundTrips: 1, masterRoundTrips: 1 },
    verdict: 'trim-permitted',
    verdictReason: '1 compared pair is content-identical once trimmed',
    ...overrides,
  };
}

describe('trimming is gated on a proof', () => {
  it('strips nothing when no proof is supplied, and records why', () => {
    const census = buildCoverageCensus(options);

    expect(census.trimVerdict.permitted).toBe(false);
    expect(census.trimVerdict.reason).toContain('no trim-equivalence proof');
    expect(census.trimmedBodyRows).toEqual([]);
    expect(census.recoverableAdmissible).toEqual([10, 20, 30]);
    expect(census.annotatedRecoverable).toEqual([40]);
    expect(coverageCensusReconciles(census)).toEqual([]);
  });

  it('strips nothing when the proof reports a content mismatch', () => {
    const census = buildCoverageCensus({
      ...options,
      trimProof: trimProof({ canonicalMatches: 0, rawByteMatches: 0, contentMismatchIds: [40] }),
    });

    expect(census.trimVerdict.permitted).toBe(false);
    expect(census.trimVerdict.reason).toContain('1 of 1');
    expect(census.trimmedBodyRows).toEqual([]);
    expect(census.recoverableAdmissible).toEqual([10, 20, 30]);
    expect(census.annotatedRecoverable).toEqual([40]);
    expect(census.perSource[1].refusedKeys).toEqual([
      { key: '_documentation', count: 1 },
      { key: '_security', count: 1 },
    ]);
  });

  it('admits a trimmed body once a permitting proof is handed over, recording the keys it removed', () => {
    const census = buildCoverageCensus({ ...options, trimProof: trimProof() });

    expect(census.trimVerdict.permitted).toBe(true);
    expect(census.recoverableAdmissible).toEqual([10, 20, 30, 40]);
    expect(census.annotatedRecoverable).toEqual([]);
    expect(census.perSource[1]).toEqual({
      dir: sourceB,
      bodyCount: 4,
      recovers: [20, 40],
      admissible: [20, 40],
      refusedKeys: [],
    });
    expect(census.trimmedBodyRows).toEqual([
      {
        templateId: 40,
        file: 'official__40_delta_annotated.json',
        sourceDir: sourceB,
        removedKeys: ['_documentation', '_security'],
      },
    ]);
    expect(coverageCensusReconciles(census)).toEqual([]);
  });

  it('refuses a census that trimmed a body while its recorded verdict says trimming is off', () => {
    const census = buildCoverageCensus({ ...options, trimProof: trimProof() });

    expect(coverageCensusReconciles({ ...census, trimVerdict: { permitted: false, reason: 'hand-edited' } })).toEqual([
      '1 body row(s) were trimmed without a permitting proof',
    ]);
  });
});
