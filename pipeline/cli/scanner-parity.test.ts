import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { describe, expect, it } from 'vitest';
import { scanWorkflow } from '../../app/src/scanner/engine.js';
import { scannerParityFixtures } from '../../app/src/scanner/__fixtures__/scanner-parity.js';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { runCli } from './cli-runner.js';
import type { ScanProfile } from './cli-contract.js';

const profiles: readonly ScanProfile[] = ['beta-default', 'beta-hardened'];
const validFixtures = scannerParityFixtures.filter((fixture) => fixture.kind === 'valid');
const rejectedFixtures = scannerParityFixtures.filter((fixture) => fixture.kind === 'rejected');

function parseFixture(json: string) {
  const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
  if (!parsed.ok) throw new Error(`Fixture did not parse: ${parsed.code}`);
  return parsed.workflow;
}

function canonicalWire(value: unknown): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(value)));
}

async function runIsolatedCli(json: string, profile: ScanProfile): Promise<unknown> {
  const output = await runCli(
    ['scan', '-', '--format', 'json', '--profile', profile],
    { stdin: new TextEncoder().encode(json), signal: new AbortController().signal },
  );
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe('');
  const document = JSON.parse(output.stdout) as { results: Array<{ ok: boolean; result?: unknown }> };
  expect(document.results).toHaveLength(1);
  expect(document.results[0]?.ok).toBe(true);
  return document.results[0]?.result;
}

describe('CLI scanner parity', () => {
  it.each(validFixtures)('matches the browser result canonically for $id in both profiles', async (fixture) => {
    const workflow = parseFixture(fixture.json);
    for (const profile of profiles) {
      const browserResult = scanWorkflow(workflow, { policyProfile: profile });
      const cliResult = await runIsolatedCli(fixture.json, profile);

        const cliWire = canonicalWire(cliResult);
        expect(cliWire).toBe(canonicalWire(browserResult));
        expect(cliWire).not.toContain('sk_live_parity_fixture_secret');
    }
  });

  it.each(rejectedFixtures)('returns the shared input rejection for $id in both profiles', async (fixture) => {
    for (const profile of profiles) {
      const output = await runCli(
        ['scan', '-', '--format', 'json', '--profile', profile],
        { stdin: new TextEncoder().encode(fixture.json), signal: new AbortController().signal },
      );
      const document = JSON.parse(output.stdout) as { results: Array<{ ok: boolean; error?: { kind: string; code: string } }> };

      expect(output.exitCode).toBe(3);
      expect(document.results).toEqual([{
        input: '-', ok: false,
        error: expect.objectContaining({ kind: 'input', code: fixture.rejectionCode }),
      }]);
    }
  });
});
