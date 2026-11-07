import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2, type ScanWorkflowV2Result, RULE_PACK_DIGEST_V2 } from '@hub/scanner-core/v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgumentsV2, type CliCommandV2 } from './arguments';
import type { BatchScanV2 } from './batch-runner';
import { loadExplicitConfig } from './config';
import { runCliV2Internal as runCliV2 } from './cli-runner-internal';

/**
 * Phase 7 external-pack boundary. The Ed25519 trust store, active/revoked rotation, and unsigned
 * development authority (WC-0702/WC-0703) are deferred post-v2, and the v2 CLI consequently admits
 * no external rule pack at all: every caller route ends in a pre-scan usage error, so the deferred
 * trust store cannot be bypassed into scoring. These cases are the evidence for that boundary;
 * the contract and `docs/scanner/cli-v2.md` say the same thing in prose.
 */

type ScanCommand = Extract<CliCommandV2, { kind: 'scan' }>;
type Envelope = {
  exitReason: string;
  artifacts: { ruleset: { id: string; signatureStatus: string } };
  invocation: { allowUnsignedDevelopmentRules: boolean; sources: { rules: string; unsignedDevelopment: string } };
  results: unknown;
};

const WORKFLOW = '{"nodes":[],"connections":{}}\n';
const directory = mkdtempSync(join(tmpdir(), 'scanner-external-pack-'));
let scans = 0;

/** Real scanner behind a counter, so a completed run carries genuine artifact identities. */
const countingScan: BatchScanV2 = (bytes): ScanWorkflowV2Result => {
  scans += 1;
  return scanWorkflowV2({ bytes, profile: { id: 'beta-default', version: '2.0.0' }, limits: DEFAULT_SCANNER_LIMITS_V2 });
};

function writeConfig(name: string, config: Record<string, unknown>): string {
  writeFileSync(join(directory, name), JSON.stringify({ schemaVersion: 'n8n-scan-config-v2', inputs: ['workflow.json'], ...config }));
  return name;
}

function scanCommand(...args: string[]): ScanCommand {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', ...args]);
  if (!parsed.ok || parsed.command.kind !== 'scan') throw new Error('Expected a parsed scan command.');
  return parsed.command;
}

beforeAll(() => {
  writeFileSync(join(directory, 'workflow.json'), WORKFLOW);
  writeConfig('minimal.json', {});
  writeConfig('builtin.json', { rules: 'builtin', catalogue: 'builtin' });
  writeConfig('external-pack.json', { rules: 'packs/external-rules.json' });
  writeConfig('external-catalogue.json', { catalogue: 'packs/external-catalogue.json' });
  writeConfig('unsigned.json', { rules: 'builtin', allowUnsignedDevelopmentRules: true });
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('external rule pack boundary', () => {
  it('refuses a rule or catalogue path at the grammar instead of admitting an external pack', () => {
    for (const [option, code] of [['--rules', 'RULE_PACK_INVALID'], ['--catalogue', 'SEMANTIC_CATALOGUE_INVALID']] as const) {
      const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'workflow.json', option, 'packs/external.json']);
      expect(parsed).toMatchObject({ ok: false, error: { code, argument: option } });
      expect(JSON.stringify(parsed)).not.toContain('packs/external.json');
    }
  });

  it('refuses the unsigned development escape hatch because no pack is admittable', () => {
    // The flag cannot succeed even beside the only admitted rules value, so nothing selects
    // unsigned authority and nothing downstream can score an unsigned pack.
    for (const argv of [
      ['--schema', 'v2', 'scan', 'workflow.json', '--allow-unsigned-development-rules'],
      ['--schema', 'v2', 'scan', 'workflow.json', '--rules', 'builtin', '--allow-unsigned-development-rules'],
    ] as const) {
      expect(parseArgumentsV2(argv)).toMatchObject({
        ok: false,
        error: { code: 'RULE_PACK_INVALID', argument: '--allow-unsigned-development-rules' },
      });
    }
  });

  it('refuses a versioned config that names an external pack or catalogue', () => {
    expect(loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', rules: 'packs/external-rules.json' }))
      .toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    expect(loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', catalogue: 'packs/external-catalogue.json' }))
      .toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
  });

  it('never scans when a config names an external pack, and emits no envelope', async () => {
    scans = 0;
    const result = await runCliV2(scanCommand('workflow.json', '--config', 'external-pack.json'), { cwd: directory, scan: countingScan });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    expect(scans).toBe(0);
  });

  it('scans only with the built-in authority, including when unsigned development is requested', async () => {
    scans = 0;
    const minimal = await runCliV2(scanCommand('workflow.json', '--config', 'minimal.json'), { cwd: directory, scan: countingScan });
    const builtin = await runCliV2(scanCommand('workflow.json', '--config', 'builtin.json'), { cwd: directory, scan: countingScan });
    const unsigned = await runCliV2(scanCommand('workflow.json', '--config', 'unsigned.json'), { cwd: directory, scan: countingScan });

    expect([minimal.exitCode, builtin.exitCode, unsigned.exitCode]).toEqual([0, 0, 0]);
    expect(scans).toBe(3);
    const envelopes = [minimal, builtin, unsigned].map(({ stdout }) => JSON.parse(stdout) as Envelope);
    for (const envelope of envelopes) {
      expect(envelope.exitReason).toBe('UNDER_THRESHOLD');
      // Every accepted run reports the same admitted authority, so no envelope can be read as an
      // external pack having been used.
      expect(envelope.artifacts.ruleset).toEqual({
        id: 'scanner-core-builtins', version: '2.0.0',
        digest: RULE_PACK_DIGEST_V2,
        signatureStatus: 'VERIFIED',
      });
    }
    // The source records which layer selected the ruleset; the admitted authority is built-in either way.
    expect(envelopes.map(({ invocation }) => invocation.sources.rules)).toEqual(['BUILT_IN', 'CONFIG', 'CONFIG']);
    // `allowUnsignedDevelopmentRules: true` records the request only: it selects no authority, and the
    // same envelope reports the same artifacts and the same results as a run that never asked for it.
    expect(envelopes.map(({ invocation }) => invocation.allowUnsignedDevelopmentRules)).toEqual([false, false, true]);
    expect(envelopes[2]!.artifacts).toEqual(envelopes[1]!.artifacts);
    expect(envelopes[2]!.results).toEqual(envelopes[1]!.results);
  });
});
