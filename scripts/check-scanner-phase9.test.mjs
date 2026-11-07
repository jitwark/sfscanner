import { describe, expect, it } from 'vitest';
import { runPhase9Gate } from './check-scanner-phase9.mjs';

const PACKETS = ['WC-0901', 'WC-0902', 'WC-0903', 'WC-0904', 'WC-0905'];
const COMMANDS = ['focused-vitest', 'file-size', 'specs', 'scanner-import-boundary', 'browser-safe'];
const DIGEST = 'a'.repeat(64);
const COMPLETE = {
  run: {
    packets: Object.fromEntries(PACKETS.map((id) => [id, { status: 'passed' }])),
    commands: Object.fromEntries(COMMANDS.map((id) => [id, { status: 'passed', exitCode: 0 }])),
    changedFiles: [{ path: 'scripts/check-scanner-phase9.mjs', lines: 190 }],
    browserSafe: { status: 'passed', violations: [] },
    v2Parity: { status: 'passed', digest: DIGEST },
    externalGates: {},
  },
  evidence: {
    packets: Object.fromEntries(PACKETS.map((id) => [id, { present: true, digest: DIGEST }])),
    v1: { expectedDigest: DIGEST, actualDigest: DIGEST },
    v2: { parityDigest: DIGEST, status: 'passed' },
    identity: {
      sourceCommit: 'd060b69', engine: DIGEST, profile: DIGEST, ruleset: DIGEST,
      semantics: DIGEST, limits: DIGEST, v1Goldens: DIGEST, v2Parity: DIGEST,
    },
  },
};

const clone = (value) => structuredClone(value);

function gate(overrides = {}) {
  const input = clone(COMPLETE);
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'run' && key !== 'evidence') continue;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
        input[key][nestedKey] = { ...input[key][nestedKey], ...nestedValue };
      } else input[key][nestedKey] = nestedValue;
    }
  }
  return runPhase9Gate(input);
}

describe('Phase 9 release-candidate checker', () => {
  it('fails closed when packet evidence is missing', () => {
    const input = clone(COMPLETE);
    delete input.evidence.packets['WC-0903'];
    const report = runPhase9Gate(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'MISSING_PACKET_EVIDENCE', subject: 'WC-0903' });
  });

  it('fails closed when a v1 digest changes', () => {
    const report = gate({ evidence: { v1: { actualDigest: 'b'.repeat(64) } } });
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'V1_DIGEST_MISMATCH', subject: 'v1' });
  });

  it('fails closed when v2 parity is not passed', () => {
    const report = gate({ run: { v2Parity: { status: 'failed', digest: DIGEST } } });
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'V2_PARITY_FAILED', subject: 'v2' });
  });

  it('fails closed when a changed file exceeds the 200-line ceiling', () => {
    const report = gate({ run: { changedFiles: [{ path: 'app/src/scanner/too-large.ts', lines: 201 }] } });
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'FILE_SIZE_EXCEEDED', subject: 'changed-files' });
  });

  it('fails closed on a browser-safe violation', () => {
    const report = gate({ run: { browserSafe: { status: 'failed', violations: [{ name: 'fetch' }] } } });
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'BROWSER_SAFE_FAILED', subject: 'browser-safe' });
  });

  it('rejects an external gate falsely marked passed', () => {
    const report = gate({ run: { externalGates: { CI_REQUIRED: { status: 'passed' } } } });
    expect(report.status).toBe('BLOCKED');
    expect(report.errors).toContainEqual({ code: 'EXTERNAL_GATE_CLAIMED', subject: 'CI_REQUIRED' });
    expect(report.externalGates.CI_REQUIRED.status).toBe('UNCLAIMED');
  });

  it('freezes complete local evidence for release review without publishing', () => {
    const report = gate();
    expect(report.status).toBe('READY_FOR_RELEASE_REVIEW');
    expect(report.publish).toBe('PUBLISH: NOT_REQUESTED');
    expect(Object.values(report.packetStatuses).map(({ status }) => status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    expect(report.externalGates.CI_REQUIRED.status).toBe('UNCLAIMED');
  });

  it('emits deterministic output independent of input insertion order', () => {
    const first = gate();
    const reversedCommands = Object.fromEntries([...COMMANDS].reverse().map((id) => [id, { status: 'passed', exitCode: 0 }]));
    const second = gate({ run: { commands: reversedCommands } });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('does not expose raw secrets or exception text in reports', () => {
    const input = clone(COMPLETE);
    input.run.commands['focused-vitest'] = {
      status: 'failed', exitCode: 1, error: 'sk_live_phase9_secret and Error: private stack trace',
    };
    const report = runPhase9Gate(input);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk_live_phase9_secret');
    expect(serialized).not.toContain('private stack trace');
    expect(report.errors).toContainEqual({ code: 'LOCAL_COMMAND_FAILED', subject: 'focused-vitest' });
  });
});
