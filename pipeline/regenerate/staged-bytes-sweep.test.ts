import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2_ARTIFACT_GROUPS } from './v2-regenerate-entry.js';
import { collectStagedFiles, manifestDigest, runPositiveControl, runSweepCli, sweepStagedBytes } from './staged-bytes-sweep.js';

const DIGEST = 'a'.repeat(64);
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-bytes-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A staged run in the shape the v2 writer emits, one line per optional override. */
function stagedRun(overrides: Readonly<Record<string, string | Uint8Array>> = {}): string {
  const root = scratch();
  const record = {
    schemaVersion: 'v2-scan-evidence-v1',
    entryId: '0000000000000001',
    scanFreshness: 'UNSCANNED',
    rightsClass: 'link_only',
    inventorySha256: DIGEST,
    scan: null,
    retainedVerdict: null,
    receiptReasonCode: null,
  };
  const plan = {
    schemaVersion: 'v2-entry-regeneration-plan-v1',
    entryId: '0000000000000001',
    state: 'UNSCANNED',
    stateReason: 'no-receipt',
    rightsClass: 'link_only',
    inventorySha256: DIGEST,
    assessment: null,
    bodySha256: null,
    resultDigest: null,
    receiptReasonCode: null,
    artifacts: V2_ARTIFACT_GROUPS.map((group) => ({ group, disposition: 'unavailable' })),
  };
  const report = {
    schemaVersion: 'v2-regeneration-run-v1',
    inventorySha256: DIGEST,
    entryCount: 1,
    states: { CURRENT: 0, NO_RESULT: 0, HISTORICAL: 0, UNSCANNED: 1, SOURCE_UNAVAILABLE: 0 },
    reasons: { 'admitted-receipt': 0, 'readiness-contradiction': 0, 'unadmitted-receipt': 0, 'no-result': 0, 'retained-verdict': 0, 'no-receipt': 1, 'owner-ruling': 0 },
    artifactGroups: V2_ARTIFACT_GROUPS.map((group) => ({ group, regenerated: 0, historical: 0, unavailable: 1 })),
    currentVerdicts: { count: 0, producingIdentities: [] },
    plans: [plan],
    formalCoverage: null,
  };
  const files: Record<string, string | Uint8Array> = {
    'v2-regeneration-report.json': `${JSON.stringify(report, null, 2)}\n`,
    'v2-scan-evidence.ndjson': `${JSON.stringify(record)}\n`,
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  return root;
}

function capture(): Readonly<{ out: () => string; err: () => string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  return { out: () => out.join(''), err: () => err.join('') };
}

/** A real NO_RESULT projection: bytes read under the admitted identity, no native result. */
function refusalRecord(extraSecurity: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = { scannerVersion: '2.0.0', engineBuildDigest: DIGEST, profileId: 'beta-default', profileVersion: '2.0.0', rulesetDigest: DIGEST, semanticsDigest: DIGEST, limitsDigest: DIGEST };
  return {
    schemaVersion: 'v2-scan-evidence-v1', entryId: '0000000000000001', scanFreshness: 'NO_RESULT', rightsClass: 'link_only', inventorySha256: DIGEST,
    scan: {
      entryId: '0000000000000001', rightsClass: 'link_only', ok: false, identity,
      bodySha256: DIGEST, resultDigest: null, analysisStatus: 'INDETERMINATE', assessment: null,
      diagnosticCodes: [], findingIds: [],
      security: {
        schemaVersion: 'scanner-result-v2', grade: 'UNKNOWN', score: 0,
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0,
        scannerVersion: '2.0.0', profile: 'beta-default', analysisStatus: 'INDETERMINATE',
        noResult: true, noResultCode: 'ENGINE_REFUSED', ...extraSecurity,
      },
    },
    retainedVerdict: null, receiptReasonCode: null,
  };
}

describe('staged-bytes sweep', () => {
  it('admits a real NO_RESULT projection and still rejects an extra security key', () => {
    const sweep = (record: Record<string, unknown>) => sweepStagedBytes({
      roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify(record)}\n` }) }],
    }).findings;
    expect(sweep(refusalRecord())).toEqual([]);
    const findings = sweep(refusalRecord({ injectedSecret: true }));
    expect(findings.some((finding) => finding.rule === 'unknown-key')).toBe(true);
  });

  it('accepts opaque slash node names but still rejects a real path in why or fix', () => {
    const finding = (node: string, why: string, fix: string) => [{ id: 'RAW_SECRET_INDICATOR', title: 't', severity: 'LOW', node, why, fix }];
    const slashNames = refusalRecord({ findings: finding('/Email/Social', 'display name only', 'rename the node') });
    expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify(slashNames)}\n` }) }] }).findings).toEqual([]);
    const leaked = refusalRecord({ findings: finding('Node', 'read /custom/private/secret.json', 'none') });
    expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify(leaked)}\n` }) }] }).findings.map((item) => item.rule)).toContain('filesystem-path');
    for (const pathText of ['../etc/passwd', '../../home/user/vault.json', 'see,/data/tenant-a/secret.json', '(/data/tenant-a/secret.json)']) {
      const traversal = refusalRecord({ findings: finding('Node', pathText, 'none') });
      expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify(traversal)}\n` }) }] }).findings.map((item) => item.rule), pathText).toContain('filesystem-path');
    }
    for (const node of ['/home/user/secret']) {
      const strict = refusalRecord({ findings: finding(node, 'display name only', 'none') });
      expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify(strict)}\n` }) }] }).findings.map((item) => item.rule), node).toContain('filesystem-path');
    }
  });

  it('decodes JSON escapes before path checks, including finding.node', () => {
    const finding = [{ id: 'RAW_SECRET_INDICATOR', title: 't', severity: 'LOW', node: 'Node', why: 'read /home/user/vault.json', fix: 'none' }];
    const record = refusalRecord({ findings: finding });
    const escaped = JSON.stringify(record).replaceAll('/', '\\/');
    expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${escaped}\n` }) }] }).findings.map((item) => item.rule)).toContain('filesystem-path');
    const nodeRecord = refusalRecord({ findings: [{ ...finding[0]!, node: '/home/user/secret', why: 'display name only' }] });
    const escapedNode = JSON.stringify(nodeRecord).replaceAll('/', '\\/');
    expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${escapedNode}\n` }) }] }).findings.map((item) => item.rule)).toContain('filesystem-path');
  });

  it('accepts a well-formed staged run and detects every planted control class', () => {
    const summary = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun() }] });

    expect(summary.findings).toEqual([]);
    expect(summary.files).toBe(2);
    expect(summary.schemaVersion).toBe('staged-bytes-sweep-v1');
    expect(summary.positiveControl.undetected).toEqual([]);
    expect(summary.positiveControl.detected).toEqual(summary.positiveControl.planted);
  });

  /**
   * The RED run: a forbidden value in a staged record has to be found, and the
   * same file without it has to pass — the detector is shown failing first.
   */
  it('names a credential, a path, a URL and a private root, and passes without them', () => {
    const planted = stagedRun({
      'v2-scan-evidence.ndjson': `${JSON.stringify({
        schemaVersion: 'v2-scan-evidence-v1', entryId: '0000000000000001', scanFreshness: 'UNSCANNED',
        rightsClass: 'link_only', inventorySha256: DIGEST, scan: null, retainedVerdict: null,
        receiptReasonCode: 'password=qqbbjjvvww0123456789',
      })}\n`,
    });
    const root = path.dirname(planted);
    const findings = sweepStagedBytes({ roots: [{ label: 'run-a', dir: planted }], privateRoots: [root] }).findings;
    const rules = findings.map((finding) => finding.rule);

    expect(rules).toContain('credential-marker');
    expect(rules).toContain('unknown-value');
    expect(sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun() }] }).findings).toEqual([]);

    const pathFindings = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify({ receiptReasonCode: 'C:\\Users\\private\\vault.json' })}\n` }) }] }).findings;
    expect(pathFindings.map((finding) => finding.rule)).toContain('filesystem-path');
    const urlFindings = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify({ receiptReasonCode: 'https://example.invalid/leak' })}\n` }) }] }).findings;
    expect(urlFindings.map((finding) => finding.rule)).toContain('url');
    const privateFindings = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify({ receiptReasonCode: `${root.toUpperCase().replace(/\\/g, '/')}/hidden.json` })}\n` }) }], privateRoots: [root] }).findings;
    expect(privateFindings.map((finding) => finding.rule)).toContain('private-root');
  });

  it('flags an unexpected file, an unknown key, a missing key and bytes that are not JSON or UTF-8', () => {
    const unexpected = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'notes.md': 'a file nobody wrote' }) }] }).findings;
    expect(unexpected.map((finding) => finding.rule)).toContain('unexpected-file');
    const unknownKey = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': `${JSON.stringify({ receiptReasonCode: null, sourcePath: 'D:/private' })}\n` }) }] }).findings;
    expect(unknownKey.map((finding) => finding.rule)).toContain('unknown-key');
    const missingKey = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': '{}\n' }) }] }).findings;
    expect(missingKey.map((finding) => finding.rule)).toContain('missing-key');
    const notJson = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': 'this is prose, not a record\n' }) }] }).findings;
    expect(notJson.map((finding) => finding.rule)).toContain('not-json');
    const notUtf8 = sweepStagedBytes({ roots: [{ label: 'run-a', dir: stagedRun({ 'v2-scan-evidence.ndjson': Uint8Array.from([0xff, 0xfe, 0x00]) }) }] }).findings;
    expect(notUtf8.map((finding) => finding.rule)).toContain('not-utf8');
  });

  it('hashes the staged map by path and content, never by mtime', () => {
    const root = stagedRun();
    const before = collectStagedFiles(root);
    const manifest = manifestDigest(before);
    expect(before.map((file) => file.path)).toEqual(['v2-regeneration-report.json', 'v2-scan-evidence.ndjson']);
    expect(manifest).toMatch(/^[0-9a-f]{64}$/);

    const report = path.join(root, 'v2-regeneration-report.json');
    fs.writeFileSync(report, fs.readFileSync(report));
    expect(manifestDigest(collectStagedFiles(root))).toBe(manifest);
    fs.appendFileSync(report, ' ');
    expect(manifestDigest(collectStagedFiles(root))).not.toBe(manifest);
  });

  it('runs as a CLI: exit 0 clean, exit 1 with a finding, exit 2 on a malformed line', () => {
    const clean = stagedRun();
    const green = capture();
    expect(runSweepCli(['--root', `run-a=${clean}`, '--json'])).toBe(0);
    expect(green.out()).toContain('"findings": []');
    const red = capture();
    expect(runSweepCli(['--root', `run-a=${clean}`, '--plant-leak'])).toBe(1);
    expect(red.out()).toContain('FINDING');
    expect(red.err()).toContain('sweep failed');
    const usage = capture();
    expect(runSweepCli(['--root'])).toBe(2);
    expect(usage.err()).toContain('requires');
  });

  it('reports the positive control as its own verdict, not as staged findings', () => {
    const control = runPositiveControl();
    expect(control.ok).toBe(true);
    expect([...control.detected].sort()).toEqual([...control.planted].sort());
    expect(control.planted).toContain('body-bytes');
    expect(control.planted).toContain('not-utf8');
  });
});
