import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVIDENCE_FRESHNESS_GATE, GATE_SEQUENCES, createGateSummary, gateEnv, runSequence, selectGateSequence, selectScannerV2BudgetGate, writeGateSummary } from './run-gates.mjs';

describe('run-gates', () => {
  it('keeps build before every build-dependent gate', () => {
    const commands = GATE_SEQUENCES.gates;
    const build = commands.indexOf('build');

    expect(build).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('check:browser-safe:emitted')).toBe(build + 1);
    expect(build).toBeLessThan(commands.indexOf('check:links'));
    expect(build).toBeLessThan(commands.indexOf('test'));
    expect(build).toBeLessThan(commands.indexOf('test:e2e'));
  });

  it('builds the packaged CLI before every gate that resolves its subpaths', () => {
    // `sfscanner/v2/*` resolves through `exports` into `packages/scanner-cli/dist`,
    // which is gitignored: without this step, a clean checkout fails in the pipeline
    // typecheck and in every test that imports the packaged subpaths.
    for (const sequence of [GATE_SEQUENCES.gates, GATE_SEQUENCES.source]) {
      expect(sequence).toContain('build:scanner');
      expect(sequence.indexOf('build:scanner')).toBeLessThan(sequence.indexOf('typecheck'));
    }
    expect(GATE_SEQUENCES.gates.indexOf('build:scanner')).toBeLessThan(GATE_SEQUENCES.gates.indexOf('check:scanner-parity'));
    expect(GATE_SEQUENCES.gates.indexOf('build:scanner')).toBeLessThan(GATE_SEQUENCES.gates.indexOf('test'));
    // The cheap source-only gates still go first, so they short-circuit before a build.
    expect(GATE_SEQUENCES.gates[0]).toBe('check:file-size:all');
    // The site build stays a corpus gate; only the CLI build is corpus-independent.
    expect(GATE_SEQUENCES.source).not.toContain('build');
  });

  it('enforces search evidence governance before ranking quality checks', () => {
    expect(GATE_SEQUENCES.gates.indexOf('check:search-governance'))
      .toBeLessThan(GATE_SEQUENCES.gates.indexOf('check:search-quality'));
  });

  it('checks committed CLI schemas before search and release checks', () => {
    expect(GATE_SEQUENCES.gates.indexOf('check:cli-schemas'))
      .toBeLessThan(GATE_SEQUENCES.gates.indexOf('check:search-governance'));
  });

  it('checks CLI docs are in sync alongside the committed CLI schema check', () => {
    expect(GATE_SEQUENCES.gates).toContain('check:cli-docs');
    expect(GATE_SEQUENCES.gates.indexOf('check:cli-docs'))
      .toBeLessThan(GATE_SEQUENCES.gates.indexOf('check:search-governance'));
  });

  it('proves the redistribution invariant before any release, and never in the source sequence', () => {
    // The artifacts are what ship. The contracts express the intent; only this
    // reads what is actually in data/ — and it cannot run where data/ is absent.
    expect(GATE_SEQUENCES.release).toContain('check:rights-invariant');
    expect(GATE_SEQUENCES.release).toContain('check:corpus-privacy');
    expect(GATE_SEQUENCES.source).not.toContain('check:rights-invariant');
    expect(GATE_SEQUENCES.source).not.toContain('check:corpus-privacy');
  });

  it('gates palette contrast, which is a safety property in a security product', () => {
    // A severity colour that disappears against its panel is not a cosmetic
    // problem: severity is how a reader learns whether a finding matters.
    expect(GATE_SEQUENCES.gates).toContain('check:contrast');
    expect(GATE_SEQUENCES.source).toContain('check:contrast');
    // The palette being sound and the palette being used soundly are different
    // questions, and only the second one caught 103 components turning
    // unreadable when the accent hue changed.
    expect(GATE_SEQUENCES.gates).toContain('check:accent-usage');
    expect(GATE_SEQUENCES.source).toContain('check:accent-usage');
  });

  it('enforces the two scanner gates that used to pass but run nowhere', () => {
    // Both scripts existed and both exited 0, but neither appeared in any
    // sequence, so nothing would have caught them going red.
    expect(GATE_SEQUENCES.gates).toContain('check:scanner-docs');
    expect(GATE_SEQUENCES.gates).toContain('check:scanner-core:bare-node');
  });

  it('runs the authority and v2 parity gates the 5.2 follow-up wired', () => {
    // Same failure mode as the pair above: both scripts existed and both exited 0,
    // but neither appeared in `package.json` or any sequence, so the authority
    // assertion only ran inside a vitest test and the v2 parity proof was a manual
    // command (`.superpowers/sdd/task-5.2-report.md` finding 4).
    expect(GATE_SEQUENCES.gates).toContain('check:scanner-authority');
    expect(GATE_SEQUENCES.gates).toContain('check:scanner-v2-parity');
    // `check:scanner-v2-parity` drives the app worker and pipeline CLI adapters, which
    // the standalone scanner repository does not ship, so only the authority gate —
    // a source-only scan — joins the source sequence.
    expect(GATE_SEQUENCES.source).toContain('check:scanner-authority');
    expect(GATE_SEQUENCES.source).not.toContain('check:scanner-v2-parity');
    // The parity gate resolves `sfscanner` subpaths through the built CLI dist.
    expect(GATE_SEQUENCES.gates.indexOf('build:scanner')).toBeLessThan(GATE_SEQUENCES.gates.indexOf('check:scanner-v2-parity'));
  });

  it('selects the explicit cross-machine policy only for CI and records it once', () => {
    expect(selectScannerV2BudgetGate({})).toBe('check:scanner-v2-budget');
    expect(selectScannerV2BudgetGate({ CI: 'false' })).toBe('check:scanner-v2-budget');
    expect(selectScannerV2BudgetGate({ CI: 'true' })).toBe('check:scanner-v2-budget:cross-machine');

    const local = selectGateSequence('gates', {});
    const ci = selectGateSequence('gates', { CI: 'true' });
    expect(local.filter((command) => command.startsWith('check:scanner-v2-budget'))).toEqual(['check:scanner-v2-budget']);
    expect(ci.filter((command) => command.startsWith('check:scanner-v2-budget'))).toEqual(['check:scanner-v2-budget:cross-machine']);
    for (const mode of ['gates', 'source', 'release']) {
      expect(selectGateSequence(mode, { CI: 'true' }).filter((command) => command.startsWith('check:scanner-v2-budget')))
        .toEqual(['check:scanner-v2-budget:cross-machine']);
    }
    expect(ci).toHaveLength(new Set(ci).size);

    const summaryCommands = [];
    runSequence(ci, () => 0, (result) => summaryCommands.push(result));
    expect(summaryCommands.find(({ command }) => command.startsWith('check:scanner-v2-budget')).command)
      .toBe('check:scanner-v2-budget:cross-machine');
  });

  it('supplies the release moment to the freshness gate without overriding a pinned date', () => {
    // `check:scanner-evidence-freshness` refuses to guess its as-of date, and that refusal is right -
    // a gate that reads the wall clock cannot be reproduced. But a sequence that never supplies one can
    // never pass, and the release sequence used to die here, hiding every gate after it.
    expect(GATE_SEQUENCES.gates).toContain(EVIDENCE_FRESHNESS_GATE);

    const supplied = gateEnv(EVIDENCE_FRESHNESS_GATE, {});
    expect(supplied.REFERENCE_DATE).toBe(new Date().toISOString().slice(0, 10));

    const pinned = { REFERENCE_DATE: '2026-09-04' };
    expect(gateEnv(EVIDENCE_FRESHNESS_GATE, pinned)).toBe(pinned);
    const epoch = { SOURCE_DATE_EPOCH: '1756944000' };
    expect(gateEnv(EVIDENCE_FRESHNESS_GATE, epoch)).toBe(epoch);

    const untouched = {};
    expect(gateEnv('build', untouched)).toBe(untouched);
    expect(gateEnv(EVIDENCE_FRESHNESS_GATE, {}).REFERENCE_DATE).toHaveLength(10);
  });

  it('excludes every corpus-dependent gate from the source sequence', () => {
    // The public scanner repository ships source without `data/`. A sequence
    // that reads the corpus can never go green there.
    const corpusDependent = [
      'build',
      'check:specs',
      'check:docs',
      'check:search-governance',
      'check:search-quality',
      'check:links',
      'check:browser-safe:emitted',
      'test:e2e',
    ];
    for (const gate of corpusDependent) {
      expect(GATE_SEQUENCES.source).not.toContain(gate);
    }
  });

  it('keeps every corpus-independent gate in the source sequence', () => {
    const required = [
      'check:file-size:all',
      'check:browser-safe',
      'check:import-boundary',
      'check:scanner-import-boundary',
      'typecheck',
      'lint',
      'audit',
      'check:cli-schemas',
      'check:cli-docs',
      'check:scanner-calibration',
      'check:scanner-parity',
      'check:scanner-goldens',
      'check:scanner-docs',
      'check:scanner-core:bare-node',
    ];
    for (const gate of required) expect(GATE_SEQUENCES.source).toContain(gate);
  });

  it('runs the source sequence in the same relative order as the core sequence', () => {
    const core = GATE_SEQUENCES.gates;
    const positions = GATE_SEQUENCES.source
      .filter((gate) => core.includes(gate))
      .map((gate) => core.indexOf(gate));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('stops at the first nonzero command and does not run later gates', () => {
    const seen = [];
    const status = runSequence(GATE_SEQUENCES.gates, (command) => {
      seen.push(command);
      return command === 'build' ? 7 : 0;
    });

    expect(status).toBe(7);
    expect(seen.at(-1)).toBe('build');
    expect(seen).not.toContain('check:links');
    expect(seen).not.toContain('check:browser-safe:emitted');
    expect(seen).not.toContain('test');
    expect(seen).not.toContain('test:e2e');
  });

  it('gates the scanner sidecar contents in the release sequence, and never in the source one', () => {
    // `check:data-sync` proves the sidecar bytes match between `data/` and
    // `app/public/data/` and that the manifest owns them; this is the only gate
    // that reads what is inside them. Both read committed corpus-adjacent data,
    // so neither can run where `data/` is absent.
    expect(GATE_SEQUENCES.release).toContain('check:scanner-advisories');
    expect(GATE_SEQUENCES.source).not.toContain('check:scanner-advisories');
  });

  it('creates a sanitized summary with commit and release identities but no command output', () => {
    const summary = createGateSummary({
      mode: 'release',
      status: 0,
      startedAt: '2026-08-28T00:00:00.000Z',
      finishedAt: '2026-08-28T00:00:01.250Z',
      durationMs: 1250,
      identities: {
        commit: 'a'.repeat(40),
        release: {
          corpusId: 'data',
          generatedAt: '2026-08-27T00:00:00.000Z',
          corpusSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
        },
      },
      commands: [{ command: 'build', status: 0, durationMs: 1250 }],
    });

    expect(summary).toEqual({
      schemaVersion: 'gate-summary-v1',
      mode: 'release',
      status: 'passed',
      startedAt: '2026-08-28T00:00:00.000Z',
      finishedAt: '2026-08-28T00:00:01.250Z',
      durationMs: 1250,
      commit: 'a'.repeat(40),
      release: {
        corpusId: 'data',
        generatedAt: '2026-08-27T00:00:00.000Z',
        corpusSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
      },
      commands: [{ command: 'build', status: 0, durationMs: 1250 }],
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('writes the summary to the configured evidence path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'community-hub-gates-'));
    const previousPath = process.env.GATE_SUMMARY_PATH;
    const summaryPath = join(directory, 'summary.json');
    process.env.GATE_SUMMARY_PATH = summaryPath;
    const summary = { schemaVersion: 'gate-summary-v1', status: 'passed' };

    try {
      expect(writeGateSummary(summary)).toBe(summaryPath);
      expect(JSON.parse(readFileSync(summaryPath, 'utf8'))).toEqual(summary);
    } finally {
      if (previousPath === undefined) delete process.env.GATE_SUMMARY_PATH;
      else process.env.GATE_SUMMARY_PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
