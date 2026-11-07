import { describe, expect, it } from 'vitest';
import { loadExplicitConfig } from './config';
import { parseArgumentsV2, parseCliArguments } from './arguments';

describe('v2 CLI grammar', () => {
  it('parses the complete scan surface deterministically', () => {
    const parsed = parseArgumentsV2([
      '--schema', 'v2', 'scan', 'workflows/a.json', '--format', 'ndjson', '--profile', 'beta-default',
      '--fail-on', 'HIGH', '--require-complete', '--max-concurrency', '4', '--rules', 'builtin',
      '--catalogue', 'builtin', '--limits', 'limits.json', '--target', 'target.json', '--n8n-version', '1.2.3',
      '--edition', 'COMMUNITY', '--deployment', 'SELF_HOSTED', '--role', 'OWNER', '--task-runner', 'NATIVE',
      '--community-package', 'example-package@1.0.0', '--configuration', 'executions.process=true',
      '--include', 'workflows/**', '--exclude', 'workflows/private/**', '--output', 'reports/out.json', '--no-color',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.kind !== 'scan') return;
    expect(parsed.command).toEqual(expect.objectContaining({
      kind: 'scan', schema: 'v2', inputs: ['workflows/a.json'], format: 'ndjson', profile: 'beta-default',
      failOn: 'HIGH', requireComplete: true, concurrency: 4, rules: 'builtin', catalogue: 'builtin',
      limits: 'limits.json', target: 'target.json', n8nVersion: '1.2.3', edition: 'COMMUNITY',
      deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: ['example-package@1.0.0'],
      configuration: ['executions.process=true'], include: ['workflows/**'], exclude: ['workflows/private/**'],
      output: 'reports/out.json', noColor: true,
    }));
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.command)).toBe(true);
    expect(Object.isFrozen(parsed.command.inputs)).toBe(true);
  });

  it('stores the canonical admitted profile and keeps the raw specifier for source projection', () => {
    const pinned = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--profile', 'beta-default@2.0.0']);
    expect(pinned).toMatchObject({
      ok: true,
      command: { profile: 'beta-default', cliOverrides: { profile: 'beta-default@2.0.0' } },
    });
    const bare = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--profile', 'beta-default']);
    expect(bare).toMatchObject({ ok: true, command: { profile: 'beta-default', cliOverrides: { profile: 'beta-default' } } });
    const defaults = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json']);
    expect(defaults).toMatchObject({ ok: true, command: { profile: 'beta-default' } });
    if (!pinned.ok || pinned.command.kind !== 'scan') throw new Error('pinned profile parse failed');
    const resolved = loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2' }, { cli: pinned.command.cliOverrides });
    expect(resolved).toMatchObject({ ok: true, config: { profile: 'beta-default' } });
    for (const invalid of ['beta-hardened', 'beta-default@9.9.9', 'BETA-DEFAULT']) {
      expect(parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--profile', invalid]))
        .toMatchObject({ ok: false, error: { code: 'PROFILE_NOT_ADMITTED', argument: '--profile' } });
    }
  });

  it('rejects duplicate, unknown, remote, and non-built-in artifact options without echoing values', () => {
    const cases = [
      ['duplicate', ['--schema', 'v2', 'scan', 'a.json', '--format', 'json', '--format', 'table']],
      ['unknown', ['--schema', 'v2', 'scan', 'a.json', '--future', 'secret-value']],
      ['remote', ['--schema', 'v2', 'scan', 'a.json', '--limits', 'https://example.test/limits']],
      ['external rules', ['--schema', 'v2', 'scan', 'a.json', '--rules', 'rules.json']],
      ['external catalogue', ['--schema', 'v2', 'scan', 'a.json', '--catalogue', 'catalogue.json']],
    ] as const;
    for (const [, argv] of cases) {
      const parsed = parseArgumentsV2(argv);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toMatch(/example\.test|private|secret-value|rules\.json|catalogue\.json/i);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(parseArgumentsV2(['--schema', 'v2', 'scan', 'C:\\private\\workflow.json'])).toMatchObject({
      ok: true,
      command: { inputs: ['C:/private/workflow.json'] },
    });
  });

  it('admits --audit-supply-chain only as a valueless scan opt-in', () => {
    expect(parseArgumentsV2(['scan', 'workflow.json']))
      .toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: false } });
    const opted = parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain']);
    expect(opted).toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: true } });
    expect(opted.ok && Object.isFrozen(opted)).toBe(true);
    expect(parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain', '--audit-supply-chain']))
      .toMatchObject({ ok: false, error: { code: 'DUPLICATE_OPTION', argument: '--audit-supply-chain' } });
    expect(parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain=true']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VALUE', argument: '--audit-supply-chain' } });
    expect(parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain', 'false']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VALUE', argument: '--audit-supply-chain' } });
    expect(parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain', 'true']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VALUE', argument: '--audit-supply-chain' } });
    expect(parseArgumentsV2(['scan', '--audit-supply-chain', '-']))
      .toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: true, inputs: ['-'] } });
    expect(parseArgumentsV2(['scan', '--audit-supply-chain', 'workflow.json']))
      .toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: true, inputs: ['workflow.json'] } });
    expect(parseArgumentsV2(['scan', 'workflow.json', '--audit-supply-chain', '--format', 'json']))
      .toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: true, format: 'json' } });
    expect(parseArgumentsV2(['scan', '--audit-supply-chain', '--', 'workflow.json']))
      .toMatchObject({ ok: true, command: { kind: 'scan', auditSupplyChain: true, inputs: ['workflow.json'] } });
    expect(parseArgumentsV2(['fix', 'suggest', '--root', '/srv/hub', '--input', 'wf.json', '--audit-supply-chain']))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPTION', argument: '--audit-supply-chain' } });
    expect(parseArgumentsV2(['rules', '--audit-supply-chain']))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPTION', argument: '--audit-supply-chain' } });
  });

  it('keeps v1 optional-scan shorthand on the legacy route', () => {
    expect(parseCliArguments(['workflow.json'])).toEqual({ mode: 'v1', argv: ['workflow.json'] });
    expect(parseCliArguments(['scan', '-', '--format', 'sarif'])).toEqual({ mode: 'v1', argv: ['scan', '-', '--format', 'sarif'] });
    const routed = parseCliArguments(['--schema', 'v2', 'rules']);
    expect(routed.mode).toBe('v2');
    if (routed.mode === 'v2') expect(routed.result).toMatchObject({ ok: true, command: { kind: 'rules' } });
  });

  it('uses input-first precedence while allowing options around the input', () => {
    const parsed = parseArgumentsV2(['scan', '--format', 'json', 'first.json', '--', 'second.json']);
    expect(parsed).toMatchObject({ ok: true, command: { kind: 'scan', inputs: ['first.json', 'second.json'], format: 'json' } });
  });
  it('keeps sparse CLI overrides separate from resolved defaults', () => {
    const defaults = parseArgumentsV2(['scan', 'workflow.json']);
    expect(defaults.ok && defaults.command.kind === 'scan' && defaults.command.cliOverrides).toEqual({ inputs: ['workflow.json'] });
    const explicit = parseArgumentsV2(['scan', 'workflow.json', '--format', 'ndjson', '--concurrency', '3']);
    expect(explicit.ok && explicit.command.kind === 'scan' && explicit.command.cliOverrides).toEqual({ format: 'ndjson', inputs: ['workflow.json'], concurrency: 3 });
    expect(explicit.ok && explicit.command.kind === 'scan' && Object.isFrozen(explicit.command.cliOverrides)).toBe(true);
  });
  it('lets only explicit CLI fields replace versioned config fields', () => {
    const config = { schemaVersion: 'n8n-scan-config-v2', format: 'table', concurrency: 8 };
    const defaults = parseArgumentsV2(['scan', 'workflow.json']);
    const explicit = parseArgumentsV2(['scan', 'workflow.json', '--format', 'ndjson', '--concurrency', '2']);
    if (!defaults.ok || !explicit.ok || defaults.command.kind !== 'scan' || explicit.command.kind !== 'scan') throw new Error('scan parse failed');
    const untouched = loadExplicitConfig(config, { cli: defaults.command.cliOverrides });
    const overridden = loadExplicitConfig(config, { cli: explicit.command.cliOverrides });
    expect(untouched.ok && untouched.config).toEqual(expect.objectContaining({ format: 'table', concurrency: 8 }));
    expect(overridden.ok && overridden.config).toEqual(expect.objectContaining({ format: 'ndjson', concurrency: 2 }));
  });

  it('rejects indeterminate thresholds, invalid bounds, inline stdin paths, and mixed stdin batches', () => {
    for (const argv of [
      ['scan', 'workflow.json', '--fail-on', 'indeterminate'],
      ['scan', 'workflow.json', '--concurrency', '0'],
      ['scan', 'workflow.json', '--max-concurrency', '17'],
      ['scan', 'workflow.json', '--timeout', '0'],
      ['scan', 'workflow.json', '--config=-'],
      ['scan', 'workflow.json', '--limits=-'],
      ['scan', 'workflow.json', '--target=-'],
      ['scan', '-', 'workflow.json'],
    ] as const) {
      const parsed = parseArgumentsV2(argv);
      expect(parsed.ok).toBe(false);
      if (argv.at(-1) === 'workflow.json' && argv[1] === '-') expect(parsed).toMatchObject({ error: { code: 'UNEXPECTED_ARGUMENT' } });
    }
  });

  it('routes canonical non-scan commands to v2 without requiring a schema marker', () => {
    for (const [name, args] of [['rules', []], ['profiles', []], ['explain', ['N8N_CODE_NODE']], ['validate-config', ['config.json']], ['version', []]] as const) {
      const dispatch = parseCliArguments([name, ...args]);
      expect(dispatch.mode).toBe('v2');
    }
  });
  it('parses deterministic v2 general and scan help commands while preserving parse details', () => {
    expect(parseCliArguments(['--schema', 'v2', '--help'])).toMatchObject({ mode: 'v2', result: { ok: true, command: { kind: 'help' } } });
    expect(parseCliArguments(['--schema', 'v2', 'scan', '--help'])).toMatchObject({ mode: 'v2', result: { ok: true, command: { kind: 'help', command: 'scan' } } });
    expect(parseArgumentsV2(['--schema', 'v2', 'scan', 'workflow.json', '--not-admitted'])).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_OPTION', message: 'Unknown option.', argument: '--not-admitted' },
    });
  });
  it('makes readiness an explicit output opt-in', () => {
    const base = ['--schema', 'v2', 'scan', 'wf.json'];
    expect(parseArgumentsV2(base)).toMatchObject({
      ok: true, command: { kind: 'scan', includeReadiness: false },
    });
    for (const format of ['json', 'ndjson', 'table']) {
      expect(parseArgumentsV2([...base, '--format', format, '--include-readiness']))
        .toMatchObject({ ok: true, command: { includeReadiness: true, format } });
    }
    expect(parseArgumentsV2([...base, '--format', 'sarif', '--include-readiness']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VALUE', argument: '--include-readiness' } });
    expect(parseArgumentsV2(['--schema', 'v2', 'rules', '--include-readiness']))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPTION', argument: '--include-readiness' } });
  });
});

describe('v2 fix grammar', () => {
  const ROOT = '/srv/hub';

  it('parses the suggest form with exactly one root, one input and an optional selection', () => {
    const parsed = parseArgumentsV2(['fix', 'suggest', '--root', ROOT, '--input', 'workflows/a.json']);
    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: 'fix', schema: 'v2', action: 'suggest', format: 'json',
        root: ROOT, input: 'workflows/a.json', confirm: false,
      },
    });
    if (!parsed.ok || parsed.command.kind !== 'fix') throw new Error('suggest parse failed');
    expect(Object.isFrozen(parsed.command)).toBe(true);
  });

  it('parses the apply form with one selected fix, explicit receipts and confirmation', () => {
    const parsed = parseArgumentsV2([
      '--schema', 'v2', 'fix', 'apply', '--root', 'C:\\work\\hub', '--input', 'workflows/a.json',
      '--fix', 'fix-0123456789ab', '--mapping', 'receipts/mapping.json',
      '--endpoint-receipt=receipts/endpoint.json', '--confirm',
    ]);
    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: 'fix', schema: 'v2', action: 'apply', format: 'json', root: 'C:/work/hub',
        input: 'workflows/a.json', fix: 'fix-0123456789ab', mapping: 'receipts/mapping.json',
        endpointReceipt: 'receipts/endpoint.json', confirm: true,
      },
    });
  });

  it('routes the fix surface to v2 without a schema marker', () => {
    expect(parseCliArguments(['fix', 'suggest', '--root', ROOT, '--input', 'wf.json']))
      .toMatchObject({ mode: 'v2', result: { ok: true, command: { kind: 'fix', action: 'suggest' } } });
    expect(parseCliArguments(['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--fix', 'fix-1', '--confirm']))
      .toMatchObject({ mode: 'v2', result: { ok: true, command: { kind: 'fix', action: 'apply', confirm: true } } });
  });

  it('refuses duplicate, extra and unknown fix arguments without echoing values', () => {
    const cases = [
      [['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--fix', 'a1', '--fix', 'b2', '--confirm'], { code: 'DUPLICATE_OPTION', argument: '--fix' }],
      [['fix', 'apply', '--root', ROOT, '--root', ROOT, '--input', 'wf.json', '--fix', 'a1', '--confirm'], { code: 'DUPLICATE_OPTION', argument: '--root' }],
      [['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--input', 'other.json', '--fix', 'a1', '--confirm'], { code: 'DUPLICATE_OPTION', argument: '--input' }],
      [['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--fix', 'a1', '--confirm', '--confirm'], { code: 'DUPLICATE_OPTION', argument: '--confirm' }],
      [['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--fix', 'a1', '--confirm=yes'], { code: 'INVALID_VALUE', argument: '--confirm' }],
      [['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--mapping', 'a.json', '--mapping', 'b.json'], { code: 'DUPLICATE_OPTION', argument: '--mapping' }],
      [['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--output', 'out.json'], { code: 'UNKNOWN_OPTION', argument: '--output' }],
      [['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--format', 'json'], { code: 'UNKNOWN_OPTION', argument: '--format' }],
      [['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--help'], { code: 'UNKNOWN_OPTION', argument: '--help' }],
      [['fix', 'suggest', '--root', ROOT, 'wf.json'], { code: 'UNEXPECTED_ARGUMENT' }],
      [['fix', 'suggest', '--root', ROOT, '--input'], { code: 'MISSING_VALUE', argument: '--input' }],
      [['fix', 'suggest', '--root', ROOT, '--input', '--fix'], { code: 'MISSING_VALUE', argument: '--input' }],
    ] as const;
    for (const [argv, expected] of cases) {
      const parsed = parseArgumentsV2(argv);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toMatchObject(expected);
      expect(JSON.stringify(parsed)).not.toMatch(/out\.json|other\.json|b\.json/u);
    }
  });

  it('refuses unknown and missing fix subcommands', () => {
    for (const argv of [['fix'], ['fix', 'revise', '--root', ROOT], ['fix', '--help']] as const) {
      expect(parseArgumentsV2(argv)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    }
  });

  it('requires one root, one input, one selection for apply and explicit confirmation', () => {
    expect(parseArgumentsV2(['fix', 'suggest', '--input', 'wf.json']))
      .toEqual({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT', message: 'fix requires exactly one --root.' } });
    expect(parseArgumentsV2(['fix', 'suggest', '--root', ROOT]))
      .toEqual({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT', message: 'fix requires exactly one --input.' } });
    expect(parseArgumentsV2(['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--confirm']))
      .toEqual({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT', message: 'fix apply requires one selected fix.' } });
    expect(parseArgumentsV2(['fix', 'apply', '--root', ROOT, '--input', 'wf.json', '--fix', 'fix-1']))
      .toEqual({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT', message: 'fix apply requires --confirm.', argument: '--confirm' } });
    expect(parseArgumentsV2(['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--confirm']))
      .toEqual({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT', message: 'The suggest action does not accept --confirm.', argument: '--confirm' } });
  });

  it('admits exactly one absolute local root and one relative file input', () => {
    for (const [root, code] of [['.', 'INVALID_VALUE'], ['relative/root', 'INVALID_VALUE'], ['https://example.test/root', 'REMOTE_PATH'], ['\\\\server\\share', 'REMOTE_PATH'], ['C:relative', 'REMOTE_PATH']] as const) {
      expect(parseArgumentsV2(['fix', 'suggest', '--root', root, '--input', 'wf.json'])).toMatchObject({ ok: false, error: { code } });
    }
    for (const [input, code] of [['../wf.json', 'REMOTE_PATH'], ['/abs/wf.json', 'REMOTE_PATH'], ['D:/abs/wf.json', 'REMOTE_PATH'], ['-', 'INVALID_VALUE']] as const) {
      expect(parseArgumentsV2(['fix', 'suggest', '--root', ROOT, '--input', input])).toMatchObject({ ok: false, error: { code } });
    }
    for (const [name, value, code] of [['--mapping', '-', 'INVALID_VALUE'], ['--endpoint-receipt', '../receipt.json', 'REMOTE_PATH']] as const) {
      expect(parseArgumentsV2(['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', name, value])).toMatchObject({ ok: false, error: { code } });
    }
  });

  it('refuses substitution, URL and secret literals instead of accepting them as values', () => {
    const cases = [
      [['--root', '{{ $env.ROOT }}', '--input', 'wf.json'], 'REMOTE_PATH'],
      [['--root', ROOT, '--input', '$env.WORKFLOW'], 'REMOTE_PATH'],
      [['--root', ROOT, '--input', 'wf.json', '--mapping', 'https://example.test/mapping.json'], 'REMOTE_PATH'],
      [['--root', ROOT, '--input', 'wf.json', '--endpoint-receipt', '${ENDPOINT_RECEIPT}'], 'REMOTE_PATH'],
      [['--root', ROOT, '--input', 'wf.json', '--fix', '{{ $env.FIX_ID }}'], 'INVALID_VALUE'],
      [['--root', ROOT, '--input', 'wf.json', '--fix', 'https://example.test/fix'], 'INVALID_VALUE'],
    ] as const;
    for (const [argv, code] of cases) {
      const parsed = parseArgumentsV2(['fix', 'suggest', ...argv]);
      expect(parsed).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(parsed)).not.toMatch(/example\.test|\$env|ENDPOINT_RECEIPT|\{\{/u);
    }
    expect(parseArgumentsV2(['fix', 'suggest', '--root', ROOT, '--input', 'wf.json', '--token', 'abc']))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPTION', argument: '--token' } });
  });

  it('parses exclusive selections without opening the root, input or receipt files', () => {
    const parsed = parseArgumentsV2([
      'fix', 'apply', '--root', 'Z:/definitely-absent-root-3f7c', '--input', 'absent/workflow.json',
      '--fix', 'fix-3f7c', '--mapping', 'absent/mapping.json', '--endpoint-receipt', 'absent/endpoint.json', '--confirm',
    ]);
    expect(parsed).toMatchObject({ ok: true, command: { kind: 'fix', action: 'apply', confirm: true } });
  });
});
