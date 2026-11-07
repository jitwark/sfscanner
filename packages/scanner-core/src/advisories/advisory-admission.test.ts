import { describe, expect, it } from 'vitest';
import { parseStrictSemver, type StrictSemver } from '../semantics/semver';
import {
  AdvisoryAdmissionError,
  admitAdvisoryCatalogue,
  createAdvisoryCatalogueDigest,
} from './advisory-admission';
import type { AdvisoryRecordV2 } from './advisory-schema';

const makeAdvisory = (overrides: Partial<AdvisoryRecordV2>): AdvisoryRecordV2 => ({
  id: 'CVE-FIXTURE-0001',
  aliases: ['CVE-FIXTURE-0001'],
  packageName: 'n8n',
  rawAffectedRange: '>=1.0.0 <2.0.0',
  affected: { clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] },
  fixedVersions: [],
  fixedBranches: [],
  prerequisites: [],
  sourceUrl: 'https://nvd.nist.gov/vuln/detail/CVE-FIXTURE-0001',
  sourceDigest: '0'.repeat(64),
  reviewedAt: '2026-09-10',
  reviewer: 'fixture-reviewer',
  reviewState: 'ADMITTED',
  ...overrides,
});

const catalogue = (records: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const body = { schemaVersion: 'scanner-advisories-v2', version: '2.0.0', records, ...overrides };
  return { ...body, digest: createAdvisoryCatalogueDigest(body) };
};

const fixed = (version: string): StrictSemver => parseStrictSemver(version);

describe('advisory catalogue admission', () => {
  it('admits complete primary-source records with canonical ranges, aliases, versions, and frozen copies', () => {
    const source = makeAdvisory({
      id: 'cve-fixture-0001',
      aliases: ['ghsa-ABCD-efgh-IJKL', 'CVE-FIXTURE-0001'],
      packageName: ' N8N ',
      rawAffectedRange: '  >=1.0.0   <2.0.0  ',
      affected: { clauses: [[{ op: 'LT', version: '2.0.0' }, { op: 'GTE', version: '1.0.0' }]] },
      fixedVersions: [fixed('1.5.0')],
      fixedBranches: ['release/2', 'main', 'main'],
      prerequisites: [{ key: 'edition', expected: 'cloud' }],
    });
    const input = catalogue([source]);
    const admitted = admitAdvisoryCatalogue(input);

    expect(admitted.version).toBe('2.0.0');
    expect(admitted.records).toHaveLength(1);
    expect(admitted.records[0].id).toBe('CVE-FIXTURE-0001');
    expect(admitted.records[0].aliases).toEqual(['CVE-FIXTURE-0001', 'GHSA-ABCD-EFGH-IJKL']);
    expect(admitted.records[0].packageName).toBe('n8n');
    expect(admitted.records[0].rawAffectedRange).toBe('  >=1.0.0   <2.0.0  ');
    expect(admitted.records[0].affected).toEqual({ clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] });
    expect(admitted.records[0].fixedVersions.map((version) => `${version.major}.${version.minor}.${version.patch}`)).toEqual(['1.5.0']);
    expect(admitted.records[0].fixedBranches).toEqual(['main', 'release/2']);
    expect(admitted.records[0].prerequisites).toEqual([{ key: 'edition', expected: 'CLOUD' }]);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.records[0].fixedVersions[0])).toBe(true);

    (source.aliases as string[]).push('MUTATED');
    (source.fixedBranches as string[]).push('mutated');
    expect(admitted.records[0].aliases).not.toContain('MUTATED');
    expect(admitted.records[0].fixedBranches).not.toContain('mutated');
  });

  it('keeps secondary-only and misattributed rows quarantined', () => {
    const admitted = admitAdvisoryCatalogue(catalogue([
      { id: 'LEGACY-001', reviewState: 'QUARANTINED', sourceUrl: 'https://example.invalid/legacy', sourceDigest: '0'.repeat(64) },
    ]));
    expect(admitted.records).toHaveLength(0);
  });

  it('accepts withdrawn and rejected records as non-applicable authority states', () => {
    const admitted = admitAdvisoryCatalogue(catalogue([
      makeAdvisory({ id: 'CVE-WITHDRAWN-0001', aliases: ['CVE-WITHDRAWN-0001'], reviewState: 'WITHDRAWN' }),
      makeAdvisory({ id: 'CVE-REJECTED-0001', aliases: ['CVE-REJECTED-0001'], reviewState: 'REJECTED' }),
    ]));
    expect(admitted.records.map(({ reviewState }) => reviewState)).toEqual(['REJECTED', 'WITHDRAWN']);
  });

  it('rejects invalid CVSS provenance and malformed primary provenance', () => {
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ cvss: { version: '3.0' as '3.1', publisher: 'NVD', vector: 'CVSS:3.1/AV:N' } })]))).toThrow(/INVALID_CVSS/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ cvss: { version: '3.1', publisher: '', vector: 'CVSS:3.1/AV:N' } })]))).toThrow(/INVALID_CVSS/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ cvss: { version: '3.1', publisher: 'NVD', vector: 'not-cvss' } })]))).toThrow(/INVALID_CVSS/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ sourceUrl: 'http://nvd.nist.gov/vuln/detail/CVE-FIXTURE-0001' })]))).toThrow(/INVALID_PROVENANCE/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ reviewedAt: '2026-02-30' })]))).toThrow(/INVALID_PROVENANCE/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ sourceDigest: 'x'.repeat(64) })]))).toThrow(/INVALID_PROVENANCE/);
  });

  it('rejects duplicate IDs, duplicate aliases, unknown keys, and digest mismatches', () => {
    expect(() => admitAdvisoryCatalogue(catalogue([
      makeAdvisory({ id: 'CVE-DUP-0001' }), makeAdvisory({ id: 'cve-dup-0001' }),
    ]))).toThrow(/DUPLICATE_ID/);
    expect(() => admitAdvisoryCatalogue(catalogue([
      makeAdvisory({ id: 'CVE-ONE-0001', aliases: ['SHARED-1'] }), makeAdvisory({ id: 'CVE-TWO-0001', aliases: ['SHARED-1'] }),
    ]))).toThrow(/DUPLICATE_ALIAS/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ unexpected: true } as Partial<AdvisoryRecordV2>)]))).toThrow(/UNKNOWN_KEY/);
    expect(() => admitAdvisoryCatalogue({ ...catalogue([]), digest: '1'.repeat(64) })).toThrow(/DIGEST_MISMATCH/);
  });

  it('deeply rejects malformed ranges and invalid fixed versions', () => {
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ affected: { clauses: [[]] } })]))).toThrow(/INVALID_RANGE/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ fixedVersions: ['01.0.0' as unknown as StrictSemver] })]))).toThrow(/INVALID_VERSION/);
    expect(() => admitAdvisoryCatalogue(catalogue([makeAdvisory({ fixedBranches: [''] })]))).toThrow(/INVALID_TEXT/);
  });
  it('verifies digests for quarantine-only and mixed catalogues', () => {
    const quarantined = { id: 'LEGACY-001', reviewState: 'QUARANTINED', sourceUrl: 'https://example.invalid/legacy', sourceDigest: '0'.repeat(64) };
    const quarantineOnly = { schemaVersion: 'scanner-advisories-v2', version: '2.0.0', records: [quarantined], digest: '0'.repeat(64) };
    expect(() => admitAdvisoryCatalogue(quarantineOnly)).toThrow(/DIGEST_MISMATCH/);

    const mixed = { schemaVersion: 'scanner-advisories-v2', version: '2.0.0', records: [quarantined, makeAdvisory({})] };
    expect(createAdvisoryCatalogueDigest(mixed)).toBe(createAdvisoryCatalogueDigest({ ...mixed, records: [makeAdvisory({})] }));
    expect(admitAdvisoryCatalogue({ ...mixed, digest: createAdvisoryCatalogueDigest(mixed) }).records).toHaveLength(1);
  });
  it('orders fixed versions by SemVer precedence', () => {
    const admitted = admitAdvisoryCatalogue(catalogue([makeAdvisory({
      fixedVersions: [fixed('1.10.0'), fixed('1.2.0')],
    })]));
    expect(admitted.records[0].fixedVersions.map((version) => `${version.major}.${version.minor}.${version.patch}`)).toEqual(['1.2.0', '1.10.0']);
  });

  it('rejects unpaired surrogates from text fields and accepts valid pairs', () => {
    const admitReviewer = (reviewer: string) => () => admitAdvisoryCatalogue(catalogue([makeAdvisory({ reviewer })]));

    expect(admitReviewer('x\ud800')).toThrow(AdvisoryAdmissionError);
    expect(admitReviewer('x\ud800')).toThrow(/INVALID_TEXT/);
    expect(admitReviewer('x\udc00')).toThrow(/INVALID_TEXT/);
    expect(admitReviewer('x\ud83d\ude00')).not.toThrow();
    expect(admitReviewer('x')).not.toThrow();
  });
});
