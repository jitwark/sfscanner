import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { evaluateV2FastForward } from './v2-fast-forward';
import {
  ADMITTED_V2_SCAN_IDENTITY,
  ENTRY_SECURITY_PROJECTION_VERSION,
  type V2RescanRecord,
} from './v2-corpus-adapter';
import type { EntrySecurity } from '@hub/contracts';

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const validJsonText = '{"nodes":[],"connections":{}}';
const validBytes = new TextEncoder().encode(validJsonText);
const validBodySha = hash(validBytes);

const sampleSecurity: EntrySecurity = {
  schemaVersion: 'scanner-result-v2',
  grade: 'LOW',
  score: 100,
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  findings: [],
  hardenedExtra: 0,
  scannerVersion: ADMITTED_V2_SCAN_IDENTITY.scannerVersion,
  profile: 'beta-default',
  analysisStatus: 'COMPLETE',
};
const sampleSecuritySha = hash(canonicalizeJson(sampleSecurity));

function sampleRecord(overrides: Partial<V2RescanRecord> = {}): V2RescanRecord {
  return {
    entryId: 'workflow-001',
    sourceDigest: validBodySha,
    inputSha256: validBodySha,
    ...ADMITTED_V2_SCAN_IDENTITY,
    analysisStatus: 'COMPLETE',
    rightsClass: 'link_only',
    ok: true,
    findingIds: [],
    grade: 'LOW',
    securityProjectionVersion: ENTRY_SECURITY_PROJECTION_VERSION,
    securitySha256: sampleSecuritySha,
    ...overrides,
  };
}

describe('evaluateV2FastForward', () => {
  it('returns HIT with security summary for exact match', () => {
    const record = sampleRecord();
    const result = evaluateV2FastForward(
      validBytes,
      'workflow-001',
      'link_only',
      record,
      sampleSecurity,
      ADMITTED_V2_SCAN_IDENTITY,
    );
    expect(result.kind).toBe('HIT');
    if (result.kind !== 'HIT') return;
    expect(result.security).toBe(sampleSecurity);
    expect(result.record).toBe(record);
  });

  it('returns MISS if previous record or previous security is missing', () => {
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', undefined, sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', sampleRecord(), undefined, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
  });

  it('returns MISS on entry ID or rights class mismatch', () => {
    expect(
      evaluateV2FastForward(validBytes, 'different-id', 'link_only', sampleRecord(), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'redistributable', sampleRecord(), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
  });

  it('returns MISS if previous scan was not ok or not COMPLETE', () => {
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', sampleRecord({ ok: false }), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', sampleRecord({ analysisStatus: 'DEGRADED' }), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
    expect(
      evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', sampleRecord({ analysisStatus: 'INDETERMINATE' }), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY).kind,
    ).toBe('MISS');
  });

  it('returns MISS on security projection version mismatch', () => {
    const wrongVersion = sampleRecord({ securityProjectionVersion: 'v2-entry-security-999' });
    const result = evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', wrongVersion, sampleSecurity, ADMITTED_V2_SCAN_IDENTITY);
    expect(result.kind).toBe('MISS');
    if (result.kind === 'MISS') expect(result.reason).toBe('PROJECTION_VERSION_MISMATCH');
  });

  it('returns MISS on authority identity mismatch', () => {
    const wrongRuleset = sampleRecord({ rulesetDigest: '0'.repeat(64) });
    const result = evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', wrongRuleset, sampleSecurity, ADMITTED_V2_SCAN_IDENTITY);
    expect(result.kind).toBe('MISS');
    if (result.kind === 'MISS') expect(result.reason).toBe('AUTHORITY_MISMATCH_RULESETDIGEST');
  });

  it('returns MISS when candidate input bytes differ (e.g. credential or payload change)', () => {
    const alteredBytes = new TextEncoder().encode('{"nodes":[],"connections":{},"secret":"changed"}');
    const result = evaluateV2FastForward(alteredBytes, 'workflow-001', 'link_only', sampleRecord(), sampleSecurity, ADMITTED_V2_SCAN_IDENTITY);
    expect(result.kind).toBe('MISS');
    if (result.kind === 'MISS') expect(result.reason).toBe('INPUT_DIGEST_MISMATCH');
  });

  it('returns MISS when previous security payload was mutated/tampered', () => {
    const mutatedSecurity: EntrySecurity = { ...sampleSecurity, grade: 'CRITICAL', score: 0 };
    const result = evaluateV2FastForward(validBytes, 'workflow-001', 'link_only', sampleRecord(), mutatedSecurity, ADMITTED_V2_SCAN_IDENTITY);
    expect(result.kind).toBe('MISS');
    if (result.kind === 'MISS') expect(result.reason).toBe('SECURITY_PAYLOAD_TAMPERED');
  });
});
