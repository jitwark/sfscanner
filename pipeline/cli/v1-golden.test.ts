import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../packages/scanner-core/src/canonical-json.js';
import { V1_GOLDEN_CASES } from '../../packages/scanner-core/src/__fixtures__/v1-goldens.js';
import { runCli } from './cli-runner.js';

const goldenKey = (fixture: { id: string; profile: string }) => `${fixture.id}:${fixture.profile}`;

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(JSON.parse(JSON.stringify(value))))));
}

function byteDigest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

// Derived from the current native v1 stdout bytes; changes require golden review.
const V1_JSON_BYTES: Readonly<Record<string, string>> = Object.freeze({
  'safe:beta-default': '0ce724e9ed3cd0e68d791bbb41096f0b119ffec40fd40daa7dbd0548aa762ad3',
  'safe:beta-hardened': '9a571c9d0ed8b54d4c7ad856c5bf0075fa4d3b8338334385fcdea1806974e639',
  'risky:beta-default': 'b39100337726e66ec6691a91e7c9f6cae2d024cfe65b8f319676b885324fe923',
  'risky:beta-hardened': '7ff898fe4f061f312e3a3ec61736a66336f4be4b2b3ee9775a1b5c22734f7c1c',
  'analyzer-cap:beta-default': '254703f789bb329a662729bf6dff10ae6b8bb608cc1589e2facee04a6278eb46',
  'analyzer-cap:beta-hardened': 'eb662aeb5e812c79645a1a4de16f03cc4273aad2c80a993a1462c1e3c918f256',
});

// The SARIF stdout bytes are deliberately not pinned here any more. Every rule descriptor now
// carries `helpUri` (`sarifHelpUriFor`, packet C-03), so this adapter's byte pin can only be
// kept green by re-recording it: the same shared `buildSarifDocument` is already byte-pinned
// for the standalone emitter in packages/scanner-cli/src/v1-golden.test.ts. What is pinned
// below is the consumer-visible projection of the JSON result the digest above freezes.
const RULE_HELP_URI = /^https:\/\/github\.com\/jitwark\/n8n-Secureflow\/blob\/main\/docs\/scanner\/policy-inventory\.md#([a-z0-9_]+)$/u;
const SARIF_LEVELS: Readonly<Record<string, string>> = Object.freeze({
  CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'note', INFO: 'note',
});

const sorted = (values: readonly string[]): string[] => [...values].sort();

type SarifRule = Readonly<{ id: string; helpUri?: string }>;
type SarifResult = Readonly<{ ruleId: string; level: string; message: { text: string }; locations?: readonly unknown[] }>;
type SarifRun = Readonly<{
  tool: { driver: { name: string; version: string; informationUri: string; rules: readonly SarifRule[] } };
  results: readonly SarifResult[];
  invocations: readonly { executionSuccessful: boolean; toolExecutionNotifications: readonly unknown[] }[];
}>;
type V1Finding = Readonly<{ policyId: string; severity: string; title: string; location: { sourceSpan?: unknown } }>;

function compatibilityProjection(result: Record<string, unknown>): unknown {
  const findings = result.findings as Array<Record<string, unknown> & { location: Record<string, unknown> }>;
  return {
    schemaVersion: result.schemaVersion,
    scannerVersion: result.scannerVersion,
    policyProfile: result.policyProfile,
    analysisStatus: result.analysisStatus,
    analysisDiagnostics: result.analysisDiagnostics,
    summary: result.summary,
    findings: findings.map((finding) => {
      const { sourceSpan: _sourceSpan, ...location } = finding.location as Record<string, unknown>;
      return { ...finding, location };
    }),
  };
}

describe('pipeline native v1 goldens', () => {
  it.each(V1_GOLDEN_CASES)('keeps the JSON result digest frozen for $id', async (fixture) => {
    const output = await runCli([
      'scan', '-', '--format', 'json', '--profile', fixture.profile,
    ], { stdin: new TextEncoder().encode(fixture.json) });
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');
    const key = goldenKey(fixture);
    expect(byteDigest(output.stdout)).toBe(V1_JSON_BYTES[key]);
    const document = JSON.parse(output.stdout) as { results: Array<{ ok: boolean; result?: Record<string, unknown> }> };
    expect(document.results).toHaveLength(1);
    expect(document.results[0]?.ok).toBe(true);
    const result = document.results[0]?.result;
    expect(result).toBeDefined();
    expect(digest(compatibilityProjection(result!))).toBe(fixture.expectedDigest);
    const repeat = await runCli([
      'scan', '-', '--format', 'json', '--profile', fixture.profile,
    ], { stdin: new TextEncoder().encode(fixture.json) });
    expect(repeat.stdout).toBe(output.stdout);

    const sarif = await runCli([
      'scan', '-', '--format', 'sarif', '--profile', fixture.profile,
    ], { stdin: new TextEncoder().encode(fixture.json) });
    expect(sarif.exitCode).toBe(0);
    expect(sarif.stderr).toBe('');
    const sarifDocument = JSON.parse(sarif.stdout) as { version: string; $schema: string; runs: SarifRun[] };
    expect(sarifDocument).toMatchObject({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json' });
    expect(sarifDocument.runs).toHaveLength(1);
    const [run] = sarifDocument.runs;
    expect(run.tool.driver).toMatchObject({ name: 'n8n-scan', version: '0.1.0', informationUri: 'https://github.com/jitwark/n8n-Secureflow' });
    expect(run.invocations).toEqual([{ executionSuccessful: true, toolExecutionNotifications: [] }]);

    const findings = result!.findings as V1Finding[];
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(sorted([...new Set(findings.map((finding) => finding.policyId))]));
    for (const rule of run.tool.driver.rules) {
      expect(rule.helpUri).toMatch(RULE_HELP_URI);
      expect(rule.helpUri?.endsWith(`#${rule.id.toLowerCase()}`)).toBe(true);
    }
    expect(sorted(run.results.map((item) => item.ruleId))).toEqual(sorted(findings.map((finding) => finding.policyId)));
    expect(sorted(run.results.map((item) => item.message.text))).toEqual(sorted(findings.map((finding) => finding.title)));
    expect(sorted(run.results.map((item) => item.level))).toEqual(sorted(findings.map((finding) => SARIF_LEVELS[finding.severity])));
    // Spans are attached only for beta-hardened, so locations track the JSON span presence.
    expect(run.results.filter((item) => item.locations !== undefined)).toHaveLength(findings.filter((finding) => finding.location.sourceSpan !== undefined).length);
  });
});
