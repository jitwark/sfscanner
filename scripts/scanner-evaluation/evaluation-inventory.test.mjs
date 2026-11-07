import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { adjudicateCalibrationCase } from '../../pipeline/calibration/v2-adjudication.ts';
import { buildEvaluationInventory, publicEvaluationReceipt } from './evaluation-inventory.mjs';
import { adjudicationEvidenceOf } from './label-evidence.mjs';

const STATES = ['BODY_AVAILABLE', 'SOURCE_UNAVAILABLE', 'NO_BODY', 'MALFORMED', 'REFUSED'];
const COHORTS = ['BUILTIN', 'THIRD_PARTY', 'UNAVAILABLE', 'MALFORMED'];
const ROW_KEYS = ['entryId', 'cohort', 'familyId', 'familyIdentity', 'familyReason', 'inputDigest', 'labelDigest', 'state', 'split'];
const PUBLIC_KEYS = ['schemaVersion', 'inventoryDigest', 'adjudicationDigest', 'splitCounts', 'stateCounts', 'cohortCounts', 'labelledRowCount', 'labelledHoldoutCount', 'authenticatedRowCount', 'authenticatedHoldoutCount', 'status', 'reasons'];
const digest = (index) => createHash('sha256').update(`synthetic-${index}`).digest('hex');
const family = (index) => `family-${String(index).padStart(5, '0')}`;
const entry = (index) => `entry-${String(index).padStart(5, '0')}`;
const row = (index, overrides = {}) => ({
  entryId: entry(index),
  cohort: 'BUILTIN',
  familyId: family(index),
  familyIdentity: 'VERIFIED',
  familyReason: null,
  inputDigest: digest(index),
  labelDigest: null,
  state: 'BODY_AVAILABLE',
  ...overrides,
});
const unresolved = (index, overrides = {}) => row(index, {
  familyId: null, familyIdentity: 'UNRESOLVED', familyReason: 'GITHUB_FAMILY_UNRESOLVED',
  inputDigest: null, state: 'SOURCE_UNAVAILABLE', ...overrides,
});
const rowsFor = (count, perFamily = 1, overrides = () => ({})) =>
  Array.from({ length: count * perFamily }, (_, index) => row(index, {
    familyId: family(Math.floor(index / perFamily)), ...overrides(index),
  }));
const decision = (reviewer, label = 'POSITIVE') => ({ reviewer, label, rationale: `rationale ${reviewer}`, reviewedAt: '2026-10-20' });
const evidenceFor = (caseId, provenanceDigest, overrides = {}) => ({
  caseId,
  status: 'AGREED',
  label: 'POSITIVE',
  decisions: [decision('reviewer-a'), decision('reviewer-b')],
  resolution: null,
  provenance: { digest: provenanceDigest, licence: 'MIT', permission: 'PERMITTED' },
  ...overrides,
});
const labelledHoldoutIndexes = [1, 6];
const labelledHoldouts = (index) => (labelledHoldoutIndexes.includes(index) ? { labelDigest: digest(`label-${index}`) } : {});
const holdoutEvidence = () => labelledHoldoutIndexes.map((index) => evidenceFor(entry(index), digest(index)));
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const hashOf = (value) => createHash('sha256').update(canonical(value)).digest('hex');

describe('complete evaluation inventory v3', () => {
  test('retains all states, cohorts, historical digests and explicit nulls without mutating inputs', () => {
    const input = [
      ...STATES.map((state, index) => row(index, { state, cohort: COHORTS[index % 4], labelDigest: index === 0 ? digest('label') : null })),
      ...COHORTS.map((cohort, index) => row(10 + index, { cohort })),
      unresolved(20), unresolved(21, { inputDigest: digest('historical'), labelDigest: digest('historical-label') }),
    ];
    const untouched = structuredClone(input);
    const inventory = buildEvaluationInventory(input, []);
    expect(inventory.schemaVersion).toBe('evaluation-inventory-v3');
    expect(input).toEqual(untouched);
    expect(inventory.rows).toHaveLength(11);
    expect(inventory.stateCounts).toEqual({ BODY_AVAILABLE: 5, SOURCE_UNAVAILABLE: 3, NO_BODY: 1, MALFORMED: 1, REFUSED: 1 });
    expect(inventory.cohortCounts).toEqual({ BUILTIN: 5, THIRD_PARTY: 2, UNAVAILABLE: 2, MALFORMED: 2 });
    expect(inventory.familyIdentityCounts).toEqual({ VERIFIED: 9, UNRESOLVED: 2 });
    expect(inventory.labelledRowCount).toBe(2);
    expect(inventory.authenticatedRowCount).toBe(0);
    expect(inventory.adjudicationCount).toBe(0);
    expect(inventory.rows.find((item) => item.entryId === entry(21))).toMatchObject({
      inputDigest: digest('historical'), labelDigest: digest('historical-label'), split: 'UNASSIGNED',
    });
    expect(Object.keys(inventory.rows[0]).sort()).toEqual([...ROW_KEYS].sort());
    for (const value of [inventory, inventory.rows, ...inventory.rows, inventory.splitCounts, inventory.stateCounts, inventory.cohortCounts, inventory.familyIdentityCounts, inventory.reasons]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(input[0])).toBe(false);
  });

  test('preserves the complete 11464-row synthetic population, including 398 unassigned rows', () => {
    const input = [
      ...rowsFor(5533, 2),
      ...Array.from({ length: 398 }, (_, index) => unresolved(11066 + index, {
        cohort: index < 3 ? 'BUILTIN' : 'THIRD_PARTY',
        familyReason: index < 3 ? 'NO_BODY_MAP_IDENTITY' : 'GITHUB_FAMILY_UNRESOLVED',
        inputDigest: index >= 3 && index < 331 ? digest(11066 + index) : null,
      })),
    ];
    const inventory = buildEvaluationInventory(input, []);
    expect(inventory.rows).toHaveLength(11464);
    expect(inventory.splitCounts).toEqual({ DEVELOPMENT: 8854, HOLDOUT: 2212, UNASSIGNED: 398 });
    expect(inventory.stateCounts).toEqual({ BODY_AVAILABLE: 11066, SOURCE_UNAVAILABLE: 398, NO_BODY: 0, MALFORMED: 0, REFUSED: 0 });
    expect(inventory.cohortCounts).toEqual({ BUILTIN: 11069, THIRD_PARTY: 395, UNAVAILABLE: 0, MALFORMED: 0 });
    expect(inventory.familyIdentityCounts).toEqual({ VERIFIED: 11066, UNRESOLVED: 398 });
    expect(inventory.rows.filter((item) => item.inputDigest === null)).toHaveLength(70);
    expect(inventory.labelledRowCount).toBe(0);
    expect(inventory.labelledHoldoutCount).toBe(0);
    expect(inventory.authenticatedHoldoutCount).toBe(0);
    expect(inventory.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(inventory.reasons).toEqual(['UNLABELLED_HOLDOUT', 'UNATTRIBUTED_HOLDOUT', 'UNRESOLVED_FAMILY']);
  });

  test('uses entry identity ordering and canonical row hashing regardless of input order', () => {
    const input = [...rowsFor(11, 2), unresolved(100)];
    const forward = buildEvaluationInventory(input, []);
    const reversed = buildEvaluationInventory([...input].reverse().map((item) => Object.fromEntries(Object.entries(item).reverse())), []);
    expect(reversed).toEqual(forward);
    expect(forward.inventoryDigest).toBe(hashOf(forward.rows));
    expect(forward.rows.map((item) => item.entryId)).toEqual(input.map((item) => item.entryId).sort());
  });

  test('keeps verified families together and excludes unresolved families from split selection', () => {
    const verified = buildEvaluationInventory(rowsFor(11, 2), []);
    const mixed = buildEvaluationInventory([...rowsFor(11, 2), unresolved(100), unresolved(101)], []);
    expect(mixed.rows.filter((item) => item.familyIdentity === 'VERIFIED')).toEqual(verified.rows);
    expect(mixed.splitCounts).toEqual({ DEVELOPMENT: 18, HOLDOUT: 4, UNASSIGNED: 2 });
    const byFamily = new Map();
    for (const item of mixed.rows.filter((entryItem) => entryItem.familyId !== null)) {
      byFamily.set(item.familyId, new Set([...(byFamily.get(item.familyId) ?? []), item.split]));
    }
    for (const splits of byFamily.values()) expect([...splits]).toHaveLength(1);
    expect([...new Set(verified.rows.filter((item) => item.split === 'HOLDOUT').map((item) => item.familyId))]).toEqual([family(1), family(6)]);
  });

  test.each([[5, [0]], [10, [0, 5]]])('holds out fifth-from-end verified families for %i families', (count, expected) => {
    const inventory = buildEvaluationInventory(rowsFor(count), []);
    expect(inventory.rows.filter((item) => item.split === 'HOLDOUT').map((item) => item.familyId)).toEqual(expected.map(family));
  });
});

describe('inventory v3 boundary refusals', () => {
  test.each([[], undefined, null, 'rows', [null], [{ ...row(0), extra: true }], [{ cohort: 'BUILTIN', familyId: family(0), inputDigest: digest(0), labelDigest: null, state: 'BODY_AVAILABLE' }]].map((input) => [input]))('refuses absent, empty, malformed or old-version row sets %#', (input) => {
    expect(() => buildEvaluationInventory(input, [])).toThrow();
  });

  test('rejects duplicate entries and non-null digests, but permits repeated null digests and exact-case-distinct entry IDs', () => {
    expect(() => buildEvaluationInventory([row(0), row(1, { entryId: row(0).entryId })], [])).toThrow();
    expect(() => buildEvaluationInventory([row(0), row(1, { inputDigest: digest(0) })], [])).toThrow();
    const inventory = buildEvaluationInventory([unresolved(0, { entryId: 'Entry' }), unresolved(1, { entryId: 'entry' })], []);
    expect(inventory.rows.map((item) => item.entryId)).toEqual(['Entry', 'entry']);
    expect(inventory.splitCounts.UNASSIGNED).toBe(2);
  });

  test('rejects unsafe identifiers and differently cased spellings of a verified family', () => {
    for (const value of ['', 'family 01', 'family/01', '../family', 'family\u0000', 'family\n01', 'x'.repeat(129), 7]) {
      expect(() => buildEvaluationInventory([row(0, { familyId: value })], [])).toThrow();
      expect(() => buildEvaluationInventory([row(0, { entryId: value })], [])).toThrow();
    }
    expect(() => buildEvaluationInventory([row(0, { familyId: 'Family' }), row(1, { familyId: 'family' })], [])).toThrow();
  });

  test.each([
    { familyIdentity: 'UNKNOWN' }, { familyIdentity: 'VERIFIED', familyId: null },
    { familyIdentity: 'VERIFIED', familyReason: 'NO_BODY_MAP_IDENTITY' },
    { familyIdentity: 'UNRESOLVED', familyId: null, familyReason: null },
    { familyIdentity: 'UNRESOLVED', familyReason: 'NO_BODY_MAP_IDENTITY' },
    { familyIdentity: 'UNRESOLVED', familyId: null, familyReason: 'GUESSED' },
  ])('rejects contradictory family identity and reason %#', (overrides) => {
    expect(() => buildEvaluationInventory([row(0, overrides)], [])).toThrow();
  });

  test('rejects malformed digests, unknown cohorts/states, missing null fields and a body without its digest', () => {
    for (const inputDigest of ['AB'.repeat(32), 'abc', '', 5, undefined, null]) {
      expect(() => buildEvaluationInventory([row(0, { inputDigest })], [])).toThrow();
    }
    for (const overrides of [{ cohort: 'builtin' }, { state: 'UNKNOWN' }, { labelDigest: '' }, { labelDigest: 'CD'.repeat(32) }, { labelDigest: undefined }, { familyReason: undefined }]) {
      expect(() => buildEvaluationInventory([row(0, overrides)], [])).toThrow();
    }
    const { familyReason: _omitted, ...missing } = row(0);
    expect(() => buildEvaluationInventory([missing], [])).toThrow();
  });

  test('refuses an absent, malformed or contradictory adjudication evidence set', () => {
    expect(() => buildEvaluationInventory(rowsFor(11), undefined)).toThrow(/array/u);
    expect(() => buildEvaluationInventory(rowsFor(11), null)).toThrow(/array/u);
    expect(() => buildEvaluationInventory(rowsFor(11), {})).toThrow(/array/u);
    const base = evidenceFor(entry(1), digest(1));
    for (const overrides of [
      { caseId: '' }, { caseId: '../escape' }, { status: 'SAFE' }, { label: 'MAYBE' },
      { label: null }, { decisions: [decision('reviewer-a')] },
      { decisions: [decision('reviewer-a'), decision('reviewer-a')] },
      { decisions: [decision('reviewer-a'), decision('reviewer-b', 'NEGATIVE')] },
      { provenance: { digest: 'AB'.repeat(32), licence: 'MIT', permission: 'PERMITTED' } },
      { provenance: { digest: digest(1), licence: '', permission: 'PERMITTED' } },
      { provenance: { digest: digest(1), licence: 'MIT' } },
      { extra: true },
    ]) {
      expect(() => buildEvaluationInventory(rowsFor(11), [{ ...base, ...overrides }])).toThrow();
    }
    expect(() => buildEvaluationInventory(rowsFor(11), [
      evidenceFor(entry(1), digest(1)),
      evidenceFor(entry(1), digest(2)),
    ])).toThrow(/one case twice/u);
    for (const status of ['DISPUTED', 'HUMAN_REQUIRED', 'INSUFFICIENT_EVIDENCE']) {
      expect(() => buildEvaluationInventory(rowsFor(11), [evidenceFor(entry(1), digest(1), { status, label: 'POSITIVE' })])).toThrow(/label must be null/u);
    }
    const settledByThird = evidenceFor(entry(1), digest(1), {
      status: 'RESOLVED',
      decisions: [decision('reviewer-a', 'POSITIVE'), decision('reviewer-b', 'NEGATIVE')],
      resolution: decision('reviewer-c', 'POSITIVE'),
    });
    expect(buildEvaluationInventory(rowsFor(11), [settledByThird]).adjudicationCount).toBe(1);
    expect(() => buildEvaluationInventory(rowsFor(11), [{ ...settledByThird, resolution: null }])).toThrow(/RESOLVED without a resolution/u);
    expect(() => buildEvaluationInventory(rowsFor(11), [{ ...settledByThird, resolution: decision('reviewer-c', 'NEGATIVE') }])).toThrow(/resolution disagrees/u);
    expect(() => buildEvaluationInventory(rowsFor(11), [{ ...settledByThird, resolution: decision('reviewer-a', 'POSITIVE') }])).toThrow(/resolution reviewer must be independent/u);
    const unanimous = evidenceFor(entry(1), digest(1), { resolution: decision('reviewer-c', 'NEGATIVE') });
    expect(() => buildEvaluationInventory(rowsFor(11), [unanimous])).toThrow(/conflicts with unanimous/u);
    const independentOnAgreed = evidenceFor(entry(1), digest(1), { resolution: decision('reviewer-c', 'POSITIVE') });
    expect(buildEvaluationInventory(rowsFor(11), [independentOnAgreed]).adjudicationCount).toBe(1);
  });
});

describe('truthful inventory readiness', () => {
  test('requires every holdout label, not just one, and retains independent unresolved reasons', () => {
    const unlabelled = buildEvaluationInventory(rowsFor(11), []);
    expect(unlabelled.reasons).toEqual(['UNLABELLED_HOLDOUT', 'UNATTRIBUTED_HOLDOUT']);
    const partial = buildEvaluationInventory(rowsFor(11, 1, (index) => (index === 1 ? { labelDigest: digest('label') } : {})), []);
    expect(partial.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(partial.labelledHoldoutCount).toBe(1);
    const mixed = buildEvaluationInventory([...rowsFor(11, 1, labelledHoldouts), unresolved(100)], holdoutEvidence());
    expect(mixed.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(mixed.reasons).toEqual(['UNRESOLVED_FAMILY']);
  });

  test('never reports READY from a caller-supplied label digest alone', () => {
    const fabricated = buildEvaluationInventory(rowsFor(11, 1, labelledHoldouts), []);
    expect(fabricated.labelledHoldoutCount).toBe(2);
    expect(fabricated.authenticatedHoldoutCount).toBe(0);
    expect(fabricated.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(fabricated.reasons).toEqual(['UNATTRIBUTED_HOLDOUT']);
    const ready = buildEvaluationInventory(rowsFor(11, 1, labelledHoldouts), holdoutEvidence());
    expect(ready).toMatchObject({ labelledHoldoutCount: 2, authenticatedHoldoutCount: 2, authenticatedRowCount: 2, status: 'READY', reasons: [] });
    expect(publicEvaluationReceipt(ready).status).toBe('READY');
  });

  test('refuses adjudications of other bytes, of other cases, and unsettled reviews as authentication', () => {
    const rows = rowsFor(11, 1, labelledHoldouts);
    const wrongBytes = buildEvaluationInventory(rows, [evidenceFor(entry(1), digest(99)), evidenceFor(entry(6), digest(98))]);
    expect(wrongBytes.authenticatedHoldoutCount).toBe(0);
    const wrongCase = buildEvaluationInventory(rows, [evidenceFor(entry(7), digest(1)), evidenceFor(entry(8), digest(6))]);
    expect(wrongCase.authenticatedHoldoutCount).toBe(0);
    const unsettled = buildEvaluationInventory(rows, [
      evidenceFor(entry(1), digest(1), { status: 'HUMAN_REQUIRED', label: null, decisions: [] }),
      evidenceFor(entry(6), digest(6), { status: 'DISPUTED', label: null, decisions: [decision('reviewer-a'), decision('reviewer-b', 'NEGATIVE')] }),
    ]);
    expect(unsettled.authenticatedHoldoutCount).toBe(0);
    expect(unsettled.adjudicationCount).toBe(2);
    const developmentOnly = buildEvaluationInventory(
      rowsFor(11, 1, (index) => ({ labelDigest: digest(`label-${index}`) })),
      [evidenceFor(entry(0), digest(0))],
    );
    expect(developmentOnly.authenticatedRowCount).toBe(1);
    expect(developmentOnly.authenticatedHoldoutCount).toBe(0);
    expect(developmentOnly.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  test('does not invent a holdout for small or entirely unresolved populations', () => {
    expect(buildEvaluationInventory(rowsFor(4), []).reasons).toEqual(['NO_HOLDOUT']);
    const inventory = buildEvaluationInventory([unresolved(0), unresolved(1)], []);
    expect(inventory.splitCounts).toEqual({ DEVELOPMENT: 0, HOLDOUT: 0, UNASSIGNED: 2 });
    expect(inventory.reasons).toEqual(['NO_HOLDOUT', 'UNRESOLVED_FAMILY']);
  });

  test('matches the canonical adjudicator on resolution independence and conflict', () => {
    const provenance = { source: 'n8n template API', commit: 'c'.repeat(40), path: 'workflows/x.json', licence: 'MIT', permission: 'PERMITTED', digest: digest(1) };
    const input = (overrides = {}) => ({
      caseId: entry(1), provenance,
      decisions: [
        { reviewer: 'reviewer-a', label: 'POSITIVE', rationale: 'source evidence A', reviewedAt: '2026-10-20' },
        { reviewer: 'reviewer-b', label: 'NEGATIVE', rationale: 'source evidence B', reviewedAt: '2026-10-20' },
      ],
      resolution: { reviewer: 'reviewer-c', label: 'POSITIVE', rationale: 'independent resolution', reviewedAt: '2026-10-21' },
      ...overrides,
    });
    const canonical = adjudicateCalibrationCase(input());
    expect(canonical).toMatchObject({ status: 'RESOLVED', label: 'POSITIVE' });
    const evidence = adjudicationEvidenceOf(canonical);
    expect(evidence).toMatchObject({ status: 'RESOLVED', label: 'POSITIVE', resolution: { reviewer: 'reviewer-c' } });
    expect(() => adjudicateCalibrationCase(input({ resolution: { reviewer: 'reviewer-a', label: 'POSITIVE', rationale: 'self-resolved', reviewedAt: '2026-10-21' } }))).toThrow(/resolution reviewer must be independent/u);
    expect(() => buildEvaluationInventory(rowsFor(11), [{
      ...evidence, resolution: decision('reviewer-a', 'POSITIVE'),
    }])).toThrow(/resolution reviewer must be independent/u);
    expect(() => adjudicateCalibrationCase(input({
      decisions: [
        { reviewer: 'reviewer-a', label: 'POSITIVE', rationale: 'source evidence A', reviewedAt: '2026-10-20' },
        { reviewer: 'reviewer-b', label: 'POSITIVE', rationale: 'source evidence B', reviewedAt: '2026-10-20' },
      ],
      resolution: { reviewer: 'reviewer-c', label: 'NEGATIVE', rationale: 'conflicting', reviewedAt: '2026-10-21' },
    }))).toThrow(/resolution conflicts with reviewer decisions/u);
    expect(() => adjudicationEvidenceOf({
      caseId: entry(1), status: 'AGREED', label: 'POSITIVE', provenance: { digest: digest(1), licence: 'MIT', permission: 'PERMITTED' },
      decisions: [{ ...decision('reviewer-a'), rules: undefined }, { ...decision('reviewer-b'), rules: undefined }],
      resolution: decision('reviewer-c', 'NEGATIVE'),
    })).toThrow(/conflicts with unanimous/u);
  });

  test('admits the pipeline adjudicator’s own settled records and refuses its unsettled ones', () => {
    const provenance = { source: 'n8n template API', commit: 'c'.repeat(40), path: 'workflows/x.json', licence: 'MIT', permission: 'PERMITTED', digest: digest(1) };
    const agreed = adjudicationEvidenceOf(adjudicateCalibrationCase({
      caseId: entry(1), provenance,
      decisions: [
        { reviewer: 'reviewer-a', label: 'POSITIVE', rationale: 'source evidence A', reviewedAt: '2026-10-20' },
        { reviewer: 'reviewer-b', label: 'POSITIVE', rationale: 'source evidence B', reviewedAt: '2026-10-20' },
      ],
    }));
    expect(agreed).toMatchObject({ caseId: entry(1), status: 'AGREED', label: 'POSITIVE' });
    const human = adjudicationEvidenceOf(adjudicateCalibrationCase({ caseId: entry(6), provenance, dispute: 'HUMAN_REQUIRED', decisions: [] }));
    expect(human).toMatchObject({ status: 'HUMAN_REQUIRED', label: null });
    const rows = rowsFor(11, 1, labelledHoldouts);
    expect(buildEvaluationInventory(rows, [agreed, human])).toMatchObject({ authenticatedHoldoutCount: 1, status: 'INSUFFICIENT_EVIDENCE' });
    expect(buildEvaluationInventory(rows, [agreed, adjudicationEvidenceOf(adjudicateCalibrationCase({
      caseId: entry(6), provenance: { ...provenance, digest: digest(6) },
      decisions: [
        { reviewer: 'reviewer-a', label: 'POSITIVE', rationale: 'source evidence A', reviewedAt: '2026-10-20' },
        { reviewer: 'reviewer-b', label: 'POSITIVE', rationale: 'source evidence B', reviewedAt: '2026-10-20' },
      ],
    }))])).toMatchObject({ authenticatedHoldoutCount: 2, status: 'READY' });
  });
});

describe('public evaluation receipt v3', () => {
  test('emits only the closed aggregate schema and never publishes identities, reviewers or label digests', () => {
    const inventory = buildEvaluationInventory([...rowsFor(11, 1, labelledHoldouts), unresolved(100)], holdoutEvidence());
    const receipt = publicEvaluationReceipt(inventory);
    expect(receipt).toEqual({
      schemaVersion: 'evaluation-inventory-public-v3', inventoryDigest: inventory.inventoryDigest,
      adjudicationDigest: inventory.adjudicationDigest,
      splitCounts: { DEVELOPMENT: 9, HOLDOUT: 2, UNASSIGNED: 1 },
      stateCounts: { BODY_AVAILABLE: 11, SOURCE_UNAVAILABLE: 1, NO_BODY: 0, MALFORMED: 0, REFUSED: 0 },
      cohortCounts: { BUILTIN: 12, THIRD_PARTY: 0, UNAVAILABLE: 0, MALFORMED: 0 },
      labelledRowCount: 2, labelledHoldoutCount: 2, authenticatedRowCount: 2, authenticatedHoldoutCount: 2,
      status: 'INSUFFICIENT_EVIDENCE', reasons: ['UNRESOLVED_FAMILY'],
    });
    expect(Object.keys(receipt).sort()).toEqual([...PUBLIC_KEYS].sort());
    const serialized = JSON.stringify(receipt);
    for (const item of inventory.rows) {
      for (const key of ['entryId', 'familyId', 'inputDigest', 'labelDigest', 'familyReason']) {
        if (item[key] !== null) expect(serialized).not.toContain(item[key]);
      }
    }
    for (const value of ['reviewer-a', 'reviewer-b', 'rationale', 'PERMITTED']) expect(serialized).not.toContain(value);
    for (const value of [receipt, receipt.splitCounts, receipt.stateCounts, receipt.cohortCounts, receipt.reasons]) expect(Object.isFrozen(value)).toBe(true);
    expect(publicEvaluationReceipt(buildEvaluationInventory([...rowsFor(11, 1, labelledHoldouts), unresolved(100)].reverse(), holdoutEvidence()))).toEqual(receipt);
  });

  test('names the adjudication evidence it relied on and changes when that evidence changes', () => {
    const rows = rowsFor(11, 1, labelledHoldouts);
    const first = buildEvaluationInventory(rows, holdoutEvidence());
    const reordered = buildEvaluationInventory(rows, [...holdoutEvidence()].reverse());
    expect(reordered.adjudicationDigest).toBe(first.adjudicationDigest);
    const relabelled = buildEvaluationInventory(rows, [holdoutEvidence()[0], { ...holdoutEvidence()[1], label: 'NEGATIVE', decisions: [decision('reviewer-a', 'NEGATIVE'), decision('reviewer-b', 'NEGATIVE')] }]);
    expect(relabelled.adjudicationDigest).not.toBe(first.adjudicationDigest);
    const receipt = publicEvaluationReceipt(first);
    expect(receipt.adjudicationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.inventoryDigest).toBe(first.inventoryDigest);
  });

  test('always retains a reasons array, including empty READY and multiple insufficient reasons', () => {
    expect(publicEvaluationReceipt(buildEvaluationInventory(rowsFor(11, 1, labelledHoldouts), holdoutEvidence())).reasons).toEqual([]);
    expect(publicEvaluationReceipt(buildEvaluationInventory([unresolved(0)], [])).reasons).toEqual(['NO_HOLDOUT', 'UNRESOLVED_FAMILY']);
  });

  test('refuses unsupported schemas, malformed counts and statuses, and count/label inconsistencies', () => {
    const inventory = buildEvaluationInventory(rowsFor(11, 1, labelledHoldouts), holdoutEvidence());
    for (const overrides of [
      { schemaVersion: 'evaluation-inventory-v2' }, { inventoryDigest: 'invalid' }, { adjudicationDigest: 'invalid' },
      { adjudicationCount: -1 }, { status: 'SAFE' },
      { labelledRowCount: -1 }, { labelledRowCount: 1 }, { labelledHoldoutCount: 3 },
      { authenticatedRowCount: 3 }, { authenticatedHoldoutCount: 1 },
      { splitCounts: { ...inventory.splitCounts, DEVELOPMENT: -1 } },
      { splitCounts: { ...inventory.splitCounts, EXTRA: 1 } },
      { stateCounts: { ...inventory.stateCounts, BODY_AVAILABLE: 12 } },
      { cohortCounts: { ...inventory.cohortCounts, BUILTIN: 12 } },
      { familyIdentityCounts: { VERIFIED: 10, UNRESOLVED: 1 } },
    ]) expect(() => publicEvaluationReceipt({ ...inventory, ...overrides })).toThrow();
  });

  test('refuses false, unknown, duplicate or noncanonical public reasons instead of sanitizing them', () => {
    const unresolvedInventory = buildEvaluationInventory([unresolved(0)], []);
    for (const reasons of [[], ['UNKNOWN'], ['NO_HOLDOUT'], ['UNRESOLVED_FAMILY'], ['NO_HOLDOUT', 'NO_HOLDOUT'], ['UNRESOLVED_FAMILY', 'NO_HOLDOUT'], ['UNATTRIBUTED_HOLDOUT']]) {
      expect(() => publicEvaluationReceipt({ ...unresolvedInventory, reasons })).toThrow();
    }
    expect(() => publicEvaluationReceipt({ ...unresolvedInventory, status: 'READY' })).toThrow();
    const ready = buildEvaluationInventory(rowsFor(11, 1, labelledHoldouts), holdoutEvidence());
    expect(() => publicEvaluationReceipt({ ...ready, status: 'INSUFFICIENT_EVIDENCE' })).toThrow();
    expect(() => publicEvaluationReceipt({ ...ready, reasons: ['UNLABELLED_HOLDOUT'] })).toThrow();
  });
});
