import { describe, expect, it } from 'vitest';
import type { EntryRights } from '@hub/contracts';
import {
  auditRedistributionEvidence,
  describeRedistributionEvidenceFailure,
  parseRightsEvidenceLedger,
  redistributionEvidenceGap,
  type RightsEvidenceLedgerRecord,
} from './recorded-evidence.js';

const entry = (
  id: string,
  status: EntryRights['status'] = 'redistributable',
): { id: string; rights: EntryRights } => ({
  id,
  rights: { status, licence: 'MIT', licenceUrl: null, reason: 'fixture' },
});

const row = (id: string, overrides: Partial<RightsEvidenceLedgerRecord> = {}): RightsEvidenceLedgerRecord => ({
  id,
  status: 'redistributable',
  evidence: {
    licenceBasis: 'same-commit-file',
    rootLicence: [{ filename: 'LICENSE', sha256: 'b'.repeat(64) }],
  },
  ...overrides,
});

const ledger = (...rows: RightsEvidenceLedgerRecord[]) => new Map(rows.map((r) => [r.id, r]));

describe('parseRightsEvidenceLedger', () => {
  it('reads one row per line and ignores blank lines', () => {
    const records = parseRightsEvidenceLedger(`${JSON.stringify(row('a'))}\n\n${JSON.stringify(row('b'))}\n`);
    expect([...records.keys()]).toEqual(['a', 'b']);
  });

  it('refuses a line it cannot read rather than skipping it', () => {
    expect(() => parseRightsEvidenceLedger('{not json}')).toThrow(/not JSON/);
    expect(() => parseRightsEvidenceLedger('{"status":"redistributable"}')).toThrow(/no entry id/);
  });

  it('refuses two rows for one entry instead of letting the last one win', () => {
    expect(() => parseRightsEvidenceLedger(`${JSON.stringify(row('a'))}\n${JSON.stringify(row('a'))}`)).toThrow(
      /more than once/,
    );
  });
});

describe('redistributionEvidenceGap', () => {
  it('accepts a claim whose recorded evidence is a same-commit instrument with a digest', () => {
    expect(redistributionEvidenceGap('a', row('a'), 'ledger.jsonl')).toBeNull();
  });

  it('reports an entry the journal does not mention', () => {
    expect(redistributionEvidenceGap('a', undefined, 'ledger.jsonl')).toContain('records no row');
  });

  it('reports a run that was given no journal at all', () => {
    expect(redistributionEvidenceGap('a', undefined, null)).toContain('no rights-evidence journal');
  });

  it('reports a journal row whose recorded decision is not redistribution', () => {
    expect(redistributionEvidenceGap('a', row('a', { status: 'link_only' }), null)).toContain('link_only');
  });

  it('reports a metadata-only basis, which names no same-commit instrument', () => {
    const record = row('a', { evidence: { licenceBasis: 'metadata-only', rootLicence: [] } });
    expect(redistributionEvidenceGap('a', record, null)).toContain('metadata-only');
  });

  it('reports a basis asserted with no recorded licence instrument behind it', () => {
    const record = row('a', { evidence: { licenceBasis: 'same-commit-file', rootLicence: [] } });
    expect(redistributionEvidenceGap('a', record, null)).toContain('no same-commit licence instrument');
  });

  it('does not accept a root NOTICE as the instrument', () => {
    const record = row('a', {
      evidence: { licenceBasis: 'same-commit-file', rootLicence: [{ filename: 'NOTICE', sha256: 'c'.repeat(64) }] },
    });
    expect(redistributionEvidenceGap('a', record, null)).toContain('no same-commit licence instrument');
  });

  it('accepts an instrument recorded in the workflow directory', () => {
    const record = row('a', {
      evidence: { licenceBasis: 'same-commit-file', siblingLicence: [{ filename: 'LICENSE', sha256: 'd'.repeat(64) }] },
    });
    expect(redistributionEvidenceGap('a', record, null)).toBeNull();
  });
});

describe('auditRedistributionEvidence', () => {
  it('counts only entries that publish a redistribution claim', () => {
    const audit = auditRedistributionEvidence(
      [entry('a'), entry('b', 'link_only'), entry('c')],
      ledger(row('a')),
      'ledger.jsonl',
    );
    expect(audit).toEqual({ claims: 2, evidenced: 1, unevidenced: [{ id: 'c', gap: expect.any(String) }] });
  });

  it('names the affected entries so a failure reports a blast radius', () => {
    const audit = auditRedistributionEvidence([entry('a'), entry('b')], ledger(), 'ledger.jsonl');
    const message = describeRedistributionEvidenceFailure(audit, 'ledger.jsonl', 1);
    expect(message).toContain('2 of 2 entries');
    expect(message).toContain('a: ledger.jsonl records no row for this entry');
    expect(message).toContain('... 1 more');
  });
});
