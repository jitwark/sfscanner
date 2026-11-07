import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The gate's argument surface is an allowlist: two flags, one value form.
 * Every rejected form has to stop before the bundle or the baseline is read,
 * because `--write-baseline` is the one command that changes repository state
 * and a bad argument must never become a baseline capture.
 */
const root = path.resolve(import.meta.dirname, '..');
const gate = path.join(import.meta.dirname, 'check-public-bundle-privacy.mjs');
const baseline = path.join(import.meta.dirname, 'public-bundle-privacy-baseline.json');

function run(args) {
  return spawnSync(process.execPath, [gate, ...args], { cwd: root, encoding: 'utf8' });
}

/** Absence is the normal state (O-2); this still notices a capture if one ever happens. */
function baselineBytes() {
  return fs.existsSync(baseline) ? fs.readFileSync(baseline, 'utf8') : null;
}

const malformed = [
  { args: ['--bundle=outputs/public-dataset'], message: /unknown argument --bundle=outputs\/public-dataset/ },
  { args: ['--bogus'], message: /unknown argument --bogus/ },
  { args: ['--bundle'], message: /--bundle needs a bundle directory/ },
  { args: ['--bundle', '--write-baseline'], message: /--bundle needs a bundle directory/ },
  { args: ['--bundle', 'a', '--bundle', 'b'], message: /--bundle was given more than once/ },
];

describe('public bundle privacy arguments', () => {
  it.each(malformed)('refuses $args before reading a bundle', ({ args, message }) => {
    const before = baselineBytes();
    const result = run(args);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain('Baseline written');
    expect(baselineBytes()).toBe(before);
  });

  it.each([
    ['--bogus', '--write-baseline'],
    ['--write-baseline', '--bogus'],
    ['--bundle', 'a', '--bundle', 'b', '--write-baseline'],
  ])('exits before writing when %s accompanies --write-baseline', (...args) => {
    const before = baselineBytes();
    const result = run(args);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Baseline written');
    expect(result.stderr).toMatch(/unknown argument|given more than once/);
    expect(baselineBytes()).toBe(before);
  });

  it('keeps the space-separated form and reaches the bundle check', () => {
    const absent = path.join(root, 'outputs', 'hub-143-absent-bundle');
    const result = run(['--bundle', absent]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no bundle at');
    expect(result.stderr).not.toContain('unknown argument');
  });
});
