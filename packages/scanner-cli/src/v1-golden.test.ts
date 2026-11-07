import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { V1_GOLDEN_CASES } from '@hub/scanner-core/test/v1-goldens';
import { runCli } from './cli.js';

const nativeStandaloneCases = V1_GOLDEN_CASES.filter((fixture) => fixture.profile === 'beta-default');
const goldenKey = (fixture: { id: string; profile: string }) => `${fixture.id}:${fixture.profile}`;

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(JSON.parse(JSON.stringify(value))))));
}

function byteDigest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

// Derived from the current native v1 stdout bytes; changes require golden review.
const V1_JSON_BYTES: Readonly<Record<string, string>> = Object.freeze({
  'safe:beta-default': '7012e86519fb7937ba988cf244222528375793bff6ae0ea1067a7780b5e8063f',
  'risky:beta-default': '4fcf6c1f1745a3e69cd4e3558c59fced060769598066c21bdaa3773f5eedc0f7',
  'analyzer-cap:beta-default': '3e21709b5d944346efdbafa6c6b2a2b41f529d35250798e52ee15f43ef3d6033',
});

// Re-pinned 2026-09-25 (golden review): these hash CLI --format sarif stdout, whose only
// moving byte is the tool driver's `informationUri`, renamed from github.com/jitwarr to
// github.com/jitwark when the owner's GitHub username changed. The JSON result goldens in
// this file did not move. See packages/scanner-core/src/report/sarif-document.test.ts for
// the diff proof.
const V1_SARIF_BYTES: Readonly<Record<string, string>> = Object.freeze({
  'safe:beta-default': '31eea90afd15e5ba9750c06895274ef2a508366d9188fa7d382c8774afba5c1f',
  'risky:beta-default': '9d9b96997f7f5d57363ddb03cb8450df587df30c069b4947fd487ced22c7ea23',
  'analyzer-cap:beta-default': 'e6a072e9fc3b2beb33fe25b0a01d7f5cce4f3cd73284f6301e4eeaf24fe9d670',
});

// The standalone v1 CLI now attaches source spans to findings so SARIF can emit physical
// locations. Spans are presentation metadata the pipeline adapter does not carry, so the
// shared semantic compatibility projection excludes them; attachment itself is pinned by
// `cli.test.ts` and the SARIF physical-location case.
function compatibilityProjection(result: Record<string, unknown>): unknown {
  const findings = (result.findings as readonly Record<string, unknown>[]).map((finding) => {
    const location = finding.location as Record<string, unknown> | undefined;
    if (location === undefined || !('sourceSpan' in location)) return finding;
    const { sourceSpan: _sourceSpan, ...semanticLocation } = location;
    return { ...finding, location: semanticLocation };
  });
  return {
    schemaVersion: result.scannerResultSchemaVersion,
    scannerVersion: result.scannerVersion,
    policyProfile: result.profile,
    analysisStatus: (result.analysis as Record<string, unknown>).status,
    analysisDiagnostics: (result.analysis as Record<string, unknown>).diagnostics,
    summary: result.summary,
    findings,
  };
}

describe('standalone native v1 goldens', () => {
  it.each(nativeStandaloneCases)('keeps the JSON result digest frozen for $id/$profile', async (fixture) => {
    const key = goldenKey(fixture);
    const output = await runCli(['-', '--format', 'json'], { stdin: fixture.json });
    expect(output.exitCode).toBe(fixture.id === 'safe' ? 0 : 1);
    expect(output.stderr).toBe('');
    expect(byteDigest(output.stdout)).toBe(V1_JSON_BYTES[key]);
    const document = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(digest(compatibilityProjection(document))).toBe(fixture.expectedDigest);
    expect((await runCli(['-', '--format', 'json'], { stdin: fixture.json })).stdout).toBe(output.stdout);

    const sarif = await runCli(['-', '--format', 'sarif'], { stdin: fixture.json });
    expect(sarif.exitCode).toBe(output.exitCode);
    expect(sarif.stderr).toBe('');
    expect(byteDigest(sarif.stdout)).toBe(V1_SARIF_BYTES[key]);
  });
});
