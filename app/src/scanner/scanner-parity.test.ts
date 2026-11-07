import { DEFAULT_SCANNER_LIMITS, SCANNER_RESULT_SCHEMA_VERSION, toWorkflowParseOptions } from '@hub/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { MAX_HARDENED_FINDINGS_PER_SCAN, scanWorkflow } from './engine';
import { canonicalJson, scannerParityFixtures } from './__fixtures__/scanner-parity';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { V1_GOLDEN_CASES } from '../../../packages/scanner-core/src/__fixtures__/v1-goldens';

const validFixtures = scannerParityFixtures.filter((fixture) => fixture.kind === 'valid');
const goldenKey = (fixture: { id: string; profile: string }) => `${fixture.id}:${fixture.profile}`;

function v1CompatibilityDigest(result: ReturnType<typeof scanWorkflow>): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson({
    schemaVersion: result.schemaVersion,
    scannerVersion: result.scannerVersion,
    policyProfile: result.policyProfile,
    analysisStatus: result.analysisStatus,
    analysisDiagnostics: result.analysisDiagnostics,
    summary: result.summary,
    findings: result.findings.map((finding) => {
      const { sourceSpan: _sourceSpan, ...location } = finding.location;
      return { ...finding, location };
    }),
  }))));
}

// Existing release-gate hashes: changing one requires an explicit golden review.
const RELEASE_BROWSER_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  'safe:beta-default': 'c4544e7c0b8ce4c980eeedefae48fac2a4e61ae669ae21e495daa58243360472',
  'safe:beta-hardened': '8a168592ea2f526eda7256bafe2382498bc8914b9a54886f79de2576bf70b6b3',
  'risky:beta-default': 'b49d83f364f2387056b5906e0a11b5c7974f146f6e8d6ec360944b663effce29',
  'risky:beta-hardened': '2eb046daf3ec404f8f3e20a7cd110d530d8ef193685e874ab9a64c67b9af7c31',
  'analyzer-cap:beta-default': 'c3fe0d63b4a1c4904db9aaaa69427e6cccb61e730b65ffd3d50b2e76998b7daa',
  'analyzer-cap:beta-hardened': 'c62ec0838d553f1514d0979d84748691bdc15ed474fd02d6db9c20b2b39fe49f',
});

describe('scanner parity fixtures', () => {
  it('pins the clean COMPLETE result canonical-byte golden', () => {
    const fixture = scannerParityFixtures.find((candidate) => candidate.id === 'safe');
    if (!fixture) throw new Error('Missing safe parity fixture');
    const parsed = parseWorkflowJson(fixture.json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' });
    const canonical = canonicalJson(result);
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.findings).toEqual([]);
    expect(bytesToHex(sha256(new TextEncoder().encode(canonical)))).toBe(
      'c4544e7c0b8ce4c980eeedefae48fac2a4e61ae669ae21e495daa58243360472',
    );
  });

  it.each(validFixtures)('scans the $id fixture in the browser engine', ({ json, id }) => {
    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });
    expect(result.schemaVersion).toBe(SCANNER_RESULT_SCHEMA_VERSION);
    expect(result.scannerVersion).toBe('scanner-beta-1');
    expect(result.policyProfile).toBe('beta-hardened');
    expect(result.analysisStatus).toMatch(/COMPLETE|DEGRADED/);

    if (id === 'safe') expect(result.findings).toEqual([]);
    if (id === 'risky') expect(result.findings.length).toBeGreaterThan(0);
    if (id === 'analyzer-cap') {
      expect(result.findings.filter((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION')).toHaveLength(MAX_HARDENED_FINDINGS_PER_SCAN);
      expect(result.analysisDiagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
    }
  });

  it.each(V1_GOLDEN_CASES)('keeps the native v1 browser digest frozen for $id/$profile', ({ id, json, profile, expectedDigest }) => {
    const key = goldenKey({ id, profile });
    const fixture = scannerParityFixtures.find((candidate) => candidate.id === id);
    expect(fixture?.json).toBe(json);
    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = scanWorkflow(parsed.workflow, { policyProfile: profile });
    expect(v1CompatibilityDigest(result)).toBe(expectedDigest);
    expect(bytesToHex(sha256(new TextEncoder().encode(canonicalJson(result))))).toBe(RELEASE_BROWSER_DIGESTS[key]);
  });

  it.each(scannerParityFixtures.filter((fixture) => fixture.kind === 'rejected'))(
    'rejects the $id fixture before browser analysis',
    ({ json, rejectionCode }) => {
      const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
      expect(parsed).toMatchObject({ ok: false, code: rejectionCode });
    },
  );
});
