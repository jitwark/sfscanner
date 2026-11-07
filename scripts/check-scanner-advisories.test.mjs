import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const checker = join(import.meta.dirname, 'check-scanner-advisories.mjs');

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function withDigest(body) {
  return { ...body, digest: createHash('sha256').update(canonical(body)).digest('hex') };
}
function runFiles(advisories, quarantine) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-advisories-'));
  const advisoryPath = join(root, 'advisories.json');
  const quarantinePath = join(root, 'quarantine.json');
  writeFileSync(advisoryPath, JSON.stringify(advisories));
  writeFileSync(quarantinePath, JSON.stringify(quarantine));
  try { return spawnSync(process.execPath, [checker, advisoryPath, quarantinePath], { encoding: 'utf8' }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function advisoryRecord(overrides = {}) {
  return {
    id: 'CVE-FIXTURE-0001',
    aliases: ['CVE-FIXTURE-0001'],
    packageName: 'n8n',
    rawAffectedRange: '>=1.0.0 <2.0.0',
    affected: { clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] },
    fixedVersions: [],
    fixedBranches: [],
    prerequisites: [],
    sourceUrl: 'https://example.com/advisories/CVE-FIXTURE-0001',
    sourceDigest: '0'.repeat(64),
    reviewedAt: '2026-09-10',
    reviewer: 'fixture-reviewer',
    reviewState: 'ADMITTED',
    ...overrides,
  };
}


const emptyAdvisories = withDigest({ schemaVersion: 'scanner-advisories-v2', version: '2.0.0', records: [] });
const emptyQuarantine = withDigest({ schemaVersion: 'scanner-advisory-quarantine-v1', version: '1.0.0', records: [] });

describe('scanner advisory data checker', () => {
  it('accepts canonical empty admitted and quarantine files', () => {
    const result = runFiles(emptyAdvisories, emptyQuarantine);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('scanner advisory data passed');
    expect(result.stderr).toBe('');
  });
  it('accepts withdrawn and rejected authority records', () => {
    const advisories = withDigest({
      schemaVersion: 'scanner-advisories-v2',
      version: '2.0.0',
      records: [
        advisoryRecord({ id: 'CVE-REJECTED-0001', aliases: ['CVE-REJECTED-0001'], reviewState: 'REJECTED' }),
        advisoryRecord({ id: 'CVE-WITHDRAWN-0001', aliases: ['CVE-WITHDRAWN-0001'], reviewState: 'WITHDRAWN' }),
      ],
    });
    const result = runFiles(advisories, emptyQuarantine);
    expect(result.status).toBe(0);
  });

  it('rejects duplicate IDs and cross-record aliases', () => {
    const duplicateId = withDigest({
      schemaVersion: 'scanner-advisories-v2',
      version: '2.0.0',
      records: [
        advisoryRecord({ id: 'CVE-DUP-0001', aliases: ['CVE-DUP-0001'] }),
        advisoryRecord({ id: 'CVE-DUP-0001', aliases: ['CVE-DUP-0001-SECONDARY'] }),
      ],
    });
    expect(runFiles(duplicateId, emptyQuarantine).status).not.toBe(0);

    const duplicateAlias = withDigest({
      schemaVersion: 'scanner-advisories-v2',
      version: '2.0.0',
      records: [
        advisoryRecord({ id: 'CVE-ONE-0001', aliases: ['SHARED-ALIAS'] }),
        advisoryRecord({ id: 'CVE-TWO-0001', aliases: ['SHARED-ALIAS'] }),
      ],
    });
    expect(runFiles(duplicateAlias, emptyQuarantine).status).not.toBe(0);
  });

  it('rejects duplicate quarantine IDs', () => {
    const quarantine = withDigest({
      schemaVersion: 'scanner-advisory-quarantine-v1',
      version: '1.0.0',
      records: [
        { id: 'LEGACY-001', reason: 'SECONDARY_ONLY' },
        { id: 'LEGACY-001', reason: 'MISATTRIBUTED' },
      ],
    });
    expect(runFiles(emptyAdvisories, quarantine).status).not.toBe(0);
  });

  it('uses semantic normalization for catalogue digests', () => {
    const record = advisoryRecord({
      id: 'cve-drift-0001',
      aliases: ['ghsa-ABCD-efgh-IJKL', 'cve-drift-0001'],
      packageName: ' N8N ',
      rawAffectedRange: '  >=1.0.0   <2.0.0  ',
      affected: { clauses: [[{ op: 'LT', version: '2.0.0' }, { op: 'GTE', version: '1.0.0' }]] },
      fixedVersions: [
        { major: 1, minor: 10, patch: 0, prerelease: [], build: [] },
        { major: 1, minor: 2, patch: 0, prerelease: [], build: [] },
      ],
      fixedBranches: ['release/2', 'main', 'main'],
      prerequisites: [{ key: 'edition', expected: 'cloud' }],
      sourceUrl: ' https://example.com/advisories/CVE-DRIFT-0001 ',
      reviewer: ' fixture-reviewer ',
    });
    const normalized = {
      schemaVersion: 'scanner-advisories-v2',
      version: '2.0.0',
      records: [{
        ...record,
        id: 'CVE-DRIFT-0001',
        aliases: ['CVE-DRIFT-0001', 'GHSA-ABCD-EFGH-IJKL'],
        packageName: 'n8n',
        affected: { clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] },
        fixedVersions: [
          { major: 1, minor: 2, patch: 0, prerelease: [], build: [] },
          { major: 1, minor: 10, patch: 0, prerelease: [], build: [] },
        ],
        fixedBranches: ['main', 'release/2'],
        prerequisites: [{ key: 'edition', expected: 'CLOUD' }],
        sourceUrl: 'https://example.com/advisories/CVE-DRIFT-0001',
        reviewer: 'fixture-reviewer',
      }],
    };
    const advisories = { ...normalized, records: [record], digest: createHash('sha256').update(canonical(normalized)).digest('hex') };
    const result = runFiles(advisories, emptyQuarantine);
    expect(result.status).toBe(0);
  });

  it('rejects non-admitted records and quarantine rows without static reasons', () => {
    const invalidAdvisory = withDigest({
      schemaVersion: 'scanner-advisories-v2', version: '2.0.0', records: [{ reviewState: 'QUARANTINED' }],
    });
    const invalid = runFiles(invalidAdvisory, emptyQuarantine);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toMatch(/static advisory data error/);

    const invalidQuarantine = withDigest({
      schemaVersion: 'scanner-advisory-quarantine-v1', version: '1.0.0', records: [{ id: 'LEGACY-001' }],
    });
    const quarantineResult = runFiles(emptyAdvisories, invalidQuarantine);
    expect(quarantineResult.status).not.toBe(0);
    expect(quarantineResult.stderr).toMatch(/static advisory data error/);
  });
});
