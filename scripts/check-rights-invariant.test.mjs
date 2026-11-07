import { describe, expect, test } from 'vitest';
import { auditRightsInvariant, BODY_BEARING_KEYS, redistributionEvidenceGap } from './lib/rights-invariant.mjs';

/**
 * The two artifact-level questions the release is checked against: a workflow
 * the record does not mark redistributable never ships a body, and a record
 * that does mark one has per-item licence evidence behind the claim.
 *
 * 11,176 of 11,464 published entries are link-only, most of them because their
 * upstream carries no licence instrument at all. `contracts/rights.ts` records
 * the intent and `download.ts` gates the download button — but nothing checked
 * the *artifacts* until this did.
 */
/**
 * The release manifest a redistributable entry's download is resolved against. A claim whose
 * coordinates the reader cannot address is rejected before the evidence question, so every
 * redistributable fixture here has to be servable or it reports a second, unrelated violation.
 */
const manifest = {
  artifacts: [{ path: 'packs/pack-0.jsonl', byteSize: 10, offsets: [0], lengths: [10] }],
};
const linkOnly = (id) => ({ id, rights: { status: 'link_only' } });
const redistributable = (id) => ({
  id,
  rights: { status: 'redistributable' },
  download: { pack: 0, line: 0, offset: 0, length: 10, sha256: 'b'.repeat(64) },
});

/** One rights-evidence journal row for `id`, as `rightsStage` writes it. */
const evidenceRow = (id, overrides = {}) => ({
  id,
  status: 'redistributable',
  evidence: {
    licenceBasis: 'same-commit-file',
    rootLicence: [{ filename: 'LICENSE', sha256: 'a'.repeat(64) }],
  },
  ...overrides,
});

describe('auditRightsInvariant pack coordinates', () => {
  test('accepts a corpus where only redistributable entries carry a body', () => {
    const result = auditRightsInvariant({
      entries: [linkOnly('a'), redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [evidenceRow('b')],
      manifest,
    });
    expect(result.violations).toEqual([]);
    expect(result.linkOnly).toBe(1);
    expect(result.redistributable).toBe(1);
  });

  test.each(BODY_BEARING_KEYS)('rejects a link-only entry carrying %s', (key) => {
    const offender = { ...linkOnly('a'), [key]: key === 'nodes' ? [{ id: 'n1' }] : { any: 'value' } };
    const { violations } = auditRightsInvariant({ entries: [offender], packWorkflowIds: [] });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('a');
    expect(violations[0]).toContain(key);
  });

  test('rejects a packed body whose entry is not redistributable', () => {
    // The pack is the actual file we serve. An id in it that is not
    // redistributable IS the redistribution, whatever the catalogue says.
    const { violations } = auditRightsInvariant({
      entries: [linkOnly('a')],
      packWorkflowIds: ['a'],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/packed workflow body/i);
    expect(violations[0]).toContain('a');
  });

  test('rejects a redistributable entry with no body, which would serve an empty download', () => {
    const { violations } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: [],
      evidenceRecords: [evidenceRow('b')],
      manifest,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no packed body/i);
  });

  test('treats an unrecognised rights status as link-only, not as permission', () => {
    // Fail closed. A status nobody anticipated must not become a licence.
    const { violations } = auditRightsInvariant({
      entries: [{ id: 'c', rights: { status: 'pending-review' }, nodes: [{ id: 'n1' }] }],
      packWorkflowIds: [],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('nodes');
  });

  test('an entry with no rights record at all is a violation in itself', () => {
    const { violations } = auditRightsInvariant({ entries: [{ id: 'd' }], packWorkflowIds: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no rights record/i);
  });

  test('names every violation, so one run reports the whole blast radius', () => {
    const { violations } = auditRightsInvariant({
      entries: [
        { ...linkOnly('a'), nodes: [{ id: 'n1' }] },
        { ...linkOnly('b'), workflow: {} },
      ],
      packWorkflowIds: ['a'],
    });

    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('auditRightsInvariant redistribution evidence', () => {
  test('reports a redistributable row with no recorded evidence at all', () => {
    // The case the committed corpus is in: the claim ships, the evidence does
    // not. Pack coordinates are consistent, so this is the only signal.
    const { violations, redistributable: redistributableCount, unevidencedClaims } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      manifest,
    });

    expect(redistributableCount).toBe(1);
    expect(unevidencedClaims).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('b');
    expect(violations[0]).toMatch(/no recorded per-item licence evidence/);
    expect(violations[0]).toMatch(/no rights-evidence journal was supplied/);
  });

  test('reports a redistributable row the journal does not mention', () => {
    const { violations } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [evidenceRow('other')],
      journalPath: 'rights-evidence.jsonl',
      manifest,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/records no row for it/);
  });

  test('reports a journal row whose recorded basis is metadata-only', () => {
    const { violations } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [evidenceRow('b', { evidence: { licenceBasis: 'metadata-only', rootLicence: [] } })],
      journalPath: 'rights-evidence.jsonl',
      manifest,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/licenceBasis "metadata-only"/);
  });

  test('reports a journal row that asserts a basis with no instrument behind it', () => {
    const { violations } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [evidenceRow('b', { evidence: { licenceBasis: 'same-commit-file', rootLicence: [] } })],
      journalPath: 'rights-evidence.jsonl',
      manifest,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no same-commit licence instrument/);
  });

  test('does not accept a root NOTICE as the licence instrument', () => {
    const { violations } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [
        evidenceRow('b', {
          evidence: { licenceBasis: 'same-commit-file', rootLicence: [{ filename: 'NOTICE', sha256: 'a'.repeat(64) }] },
        }),
      ],
      journalPath: 'rights-evidence.jsonl',
      manifest,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no same-commit licence instrument/);
  });

  test('leaves link-only rows alone, wherever their licence id came from', () => {
    const { violations, unevidencedClaims } = auditRightsInvariant({
      entries: [linkOnly('a')],
      packWorkflowIds: [],
    });

    expect(violations).toEqual([]);
    expect(unevidencedClaims).toBe(0);
  });

  test('a claim whose evidence is sufficient is not a violation', () => {
    const { violations, unevidencedClaims } = auditRightsInvariant({
      entries: [redistributable('b')],
      packWorkflowIds: ['b'],
      evidenceRecords: [evidenceRow('b')],
      journalPath: 'rights-evidence.jsonl',
      manifest,
    });

    expect(violations).toEqual([]);
    expect(unevidencedClaims).toBe(0);
  });
});

describe('redistributionEvidenceGap', () => {
  test('accepts an instrument recorded beside the workflow', () => {
    const record = evidenceRow('b', {
      evidence: { licenceBasis: 'same-commit-file', siblingLicence: [{ filename: 'LICENSE', sha256: 'b'.repeat(64) }] },
    });
    expect(redistributionEvidenceGap('b', record, 'rights-evidence.jsonl')).toBeNull();
  });

  test('reports a recorded decision that is not redistribution', () => {
    expect(redistributionEvidenceGap('b', { id: 'b', status: 'link_only' }, null)).toMatch(/status "link_only"/);
  });
});
