import { describe, expect, it } from 'vitest';
import {
  CLI_EXIT_CODES,
  parseCliArguments,
  resolveScanExitCode,
} from './cli-contract';

describe('CLI contract', () => {
  it('parses a deterministic scan command with repeated and scalar options', () => {
    expect(parseCliArguments([
      'scan', 'one.json', '--format', 'sarif', '--profile=beta-hardened',
      '--approved-domain', 'api.example.test', '--approved-domain=hooks.example.test',
      '--fail-on', 'high', '--max-concurrency', '4', '--timeout=1500',
      '--include', '**/*.json', '--exclude', 'fixtures/**', '--no-color',
    ])).toEqual({
      ok: true,
      command: {
        kind: 'scan', inputs: ['one.json'], format: 'sarif', profile: 'beta-hardened',
        approvedDomains: ['api.example.test', 'hooks.example.test'], failOn: 'HIGH',
        maxConcurrency: 4, timeoutMs: 1500, include: ['**/*.json'], exclude: ['fixtures/**'],
        noColor: true,
      },
    });
  });

  it('rejects the removed --quiet flag as an unknown option', () => {
    const result = parseCliArguments(['scan', '-', '--quiet']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ code: 'UNKNOWN_OPTION', message: 'Unknown option: --quiet', argument: '--quiet' });
  });

  it('supports stdin and an explicit end-of-options marker', () => {
    expect(parseCliArguments(['scan'])).toMatchObject({ ok: true, command: { inputs: [] } });
    expect(parseCliArguments(['scan', '-'])).toMatchObject({ ok: true, command: { inputs: ['-'] } });
    expect(parseCliArguments(['scan', '--', '--workflow.json'])).toMatchObject({
      ok: true, command: { inputs: ['--workflow.json'] },
    });
  });

  it('accepts the separate stdout sentinel as an output path token', () => {
    expect(parseCliArguments(['scan', 'workflow.json', '--output', '-'])).toMatchObject({
      ok: true,
      command: { kind: 'scan', inputs: ['workflow.json'], output: '-' },
    });
  });

  it.each([
    [['rules', '--json'], 'UNEXPECTED_ARGUMENT'],
    [['scan', '--format', 'yaml'], 'INVALID_VALUE'],
    [['scan', '--timeout', '0'], 'INVALID_VALUE'],
    [['scan', '--unknown'], 'UNKNOWN_OPTION'],
    [['explain'], 'UNEXPECTED_ARGUMENT'],
    [['version', '--json', 'extra'], 'UNEXPECTED_ARGUMENT'],
  ] as const)('rejects invalid invocation %j with %s', (argv, code) => {
    const result = parseCliArguments(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('parses the non-scan commands without accepting scan options', () => {
    expect(parseCliArguments(['rules'])).toEqual({ ok: true, command: { kind: 'rules' } });
    expect(parseCliArguments(['explain', 'SECRET_TOKEN'])).toEqual({ ok: true, command: { kind: 'explain', policyId: 'SECRET_TOKEN' } });
    expect(parseCliArguments(['version', '--json'])).toEqual({ ok: true, command: { kind: 'version', json: true } });
  });

  it('accepts indeterminate as a failure threshold', () => {
    expect(parseCliArguments(['scan', '-', '--fail-on', 'indeterminate'])).toMatchObject({
      ok: true,
      command: { kind: 'scan', failOn: 'indeterminate' },
    });
  });

  it.each([
    ['0', undefined],
    ['1', 1],
    [String(2 ** 31 - 1), 2 ** 31 - 1],
    [String(2 ** 31), undefined],
    [String(Number.MAX_SAFE_INTEGER), undefined],
    ['9007199254740993', undefined],
    ['1'.padEnd(400, '0'), undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['1.5', undefined],
  ] as const)('bounds --timeout=%s to the setTimeout-safe range', (value, expected) => {
    const result = parseCliArguments(['scan', '-', `--timeout=${value}`]);
    if (expected === undefined) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'INVALID_VALUE', message: `Invalid value: ${value}`, argument: '--timeout' });
    } else {
      expect(result).toMatchObject({ ok: true, command: { timeoutMs: expected } });
    }
  });

  it('rejects an empty --timeout value as a missing value, not an invalid one', () => {
    const result = parseCliArguments(['scan', '-', '--timeout=']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_VALUE');
  });

  it.each([
    ['0', undefined],
    ['1', 1],
    ['16', 16],
    ['17', undefined],
    [String(Number.MAX_SAFE_INTEGER), undefined],
    ['9007199254740993', undefined],
    ['1'.padEnd(400, '0'), undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['1.5', undefined],
  ] as const)('bounds --max-concurrency=%s to its own, smaller ceiling', (value, expected) => {
    const result = parseCliArguments(['scan', '-', `--max-concurrency=${value}`]);
    if (expected === undefined) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'INVALID_VALUE', message: `Invalid value: ${value}`, argument: '--max-concurrency' });
    } else {
      expect(result).toMatchObject({ ok: true, command: { maxConcurrency: expected } });
    }
  });

  it('rejects an empty --max-concurrency value as a missing value, not an invalid one', () => {
    const result = parseCliArguments(['scan', '-', '--max-concurrency=']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_VALUE');
  });

  it('uses cancellation, internal, input, then finding precedence', () => {
    expect(resolveScanExitCode({ finding: true })).toBe(CLI_EXIT_CODES.FINDINGS);
    expect(resolveScanExitCode({ finding: true, inputError: true })).toBe(CLI_EXIT_CODES.INPUT);
    expect(resolveScanExitCode({ finding: true, internalError: true, inputError: true })).toBe(CLI_EXIT_CODES.INTERNAL);
    expect(resolveScanExitCode({ cancelled: true, internalError: true })).toBe(CLI_EXIT_CODES.CANCELLED);
    expect(resolveScanExitCode({ indeterminate: true })).toBe(CLI_EXIT_CODES.INPUT);
    expect(resolveScanExitCode({ indeterminate: true, finding: true })).toBe(CLI_EXIT_CODES.FINDINGS);
    expect(resolveScanExitCode({})).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});
