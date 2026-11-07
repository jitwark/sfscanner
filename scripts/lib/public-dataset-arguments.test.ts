import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePublicDatasetArguments, PublicDatasetUsageError } from './public-dataset-arguments.js';

// The parser is the only thing between the command line and the corpus: every
// vector below that ends in a rejection must throw before a single path is
// resolved, let alone read.
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// Deliberately not the process cwd: with the two roots identical (as they are
// when the suite runs from the repo root) the cwd-relative and repo-relative
// rules resolve to the same string, so no assertion binds either one.
const fakeRoot = path.join(process.cwd(), 'fake-repo-root');

const failureFor = (argv: readonly string[]): PublicDatasetUsageError => {
  try {
    parsePublicDatasetArguments(argv, repoRoot);
  } catch (error) {
    if (error instanceof PublicDatasetUsageError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(argv)} to be rejected`);
};

describe('parsePublicDatasetArguments', () => {
  it('defaults to the repo-relative corpus and bundle destinations', () => {
    expect(parsePublicDatasetArguments([], repoRoot)).toEqual({
      dataDir: path.join(repoRoot, 'data'),
      outputDir: path.join(repoRoot, 'outputs', 'public-dataset'),
      generatedAt: undefined,
    });
  });

  it('resolves explicitly supplied paths against the process cwd, not the repo root', () => {
    const args = parsePublicDatasetArguments(['--data', 'rel/data', '--out', 'rel/out'], fakeRoot);

    expect(args.dataDir).toBe(path.resolve('rel/data'));
    expect(args.outputDir).toBe(path.resolve('rel/out'));
    // The repo-relative rule would land somewhere else, so switching either
    // resolution to the other rule now fails this test.
    expect(args.dataDir).not.toBe(path.resolve(fakeRoot, 'rel/data'));
    expect(args.outputDir).not.toBe(path.resolve(fakeRoot, 'rel/out'));
    expect(args.generatedAt).toBeUndefined();
  });

  it('resolves the defaults under the repo root, not the cwd', () => {
    const defaults = parsePublicDatasetArguments([], fakeRoot);

    expect(defaults).toEqual({
      dataDir: path.resolve(fakeRoot, 'data'),
      outputDir: path.resolve(fakeRoot, 'outputs', 'public-dataset'),
      generatedAt: undefined,
    });
    expect(defaults.dataDir).not.toBe(path.resolve('data'));
  });

  it('carries an exact ISO timestamp through unchanged', () => {
    expect(parsePublicDatasetArguments(['--generated-at', '2026-10-17T00:00:00.000Z'], repoRoot).generatedAt).toBe(
      '2026-10-17T00:00:00.000Z',
    );
  });

  it.each<[string, string[]]>([
    ['a bare --out', ['--out']],
    ['a bare --data', ['--data']],
    ['a bare --generated-at', ['--generated-at']],
    ['a value that is really the next flag', ['--out', '--data', 'x']],
    ['a flag where the value belongs, last token', ['--out', '--data']],
    ['an unknown option', ['--bogus', 'x']],
    ['a repeated option', ['--out', 'a', '--out', 'b']],
    ['a date no calendar has', ['--generated-at', '2026-13-45']],
    ['an ISO timestamp without milliseconds', ['--generated-at', '2026-10-17T00:00:00Z']],
    ['an ISO timestamp with a UTC offset', ['--generated-at', '2026-10-17T00:00:00.000+02:00']],
    ['an empty date', ['--generated-at', '']],
    ['an empty path', ['--out', '']],
  ])('rejects %s', (_case, argv) => {
    expect(() => parsePublicDatasetArguments(argv, repoRoot)).toThrow(PublicDatasetUsageError);
  });

  it('names the offending option and never quotes a supplied value', () => {
    const badDate = 'not-a-date-9f3a';
    expect(failureFor(['--generated-at', badDate]).message).toMatch(/--generated-at/);
    expect(failureFor(['--generated-at', badDate]).message).not.toContain(badDate);
    expect(failureFor(['--out', 'a', '--out', 'b']).message).toMatch(/--out/);
    expect(failureFor(['--bogus', 'untrusted-9f3a']).message).toMatch(/unknown option/);
    expect(failureFor(['--bogus', 'untrusted-9f3a']).message).not.toContain('untrusted-9f3a');
  });

  it('names the option whose value was missing, so dropping the flag-shaped-value guard fails', () => {
    const flagAsValue = failureFor(['--out', '--data', 'x']);
    expect(flagAsValue.message).toBe('--out requires a value');
    expect(flagAsValue.argument).toBe('--out');

    const flagAsLastValue = failureFor(['--out', '--data']);
    expect(flagAsLastValue.message).toBe('--out requires a value');
    expect(flagAsLastValue.argument).toBe('--out');
  });

  it('never echoes an equals-form value, in the message or anywhere on the error', () => {
    const secret = 'Zq9_SECRET_MARKER';
    const credentials = 'https://user:pass@host/x';

    for (const argv of [
      [`--data=${secret}`],
      [`--out=${secret}`],
      [`--${secret}=x`],
      [`--data=${credentials}`],
      ['--bogus', secret],
      ['--out', `--data=${secret}`],
    ]) {
      const error = failureFor(argv);
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain('user:pass');
    }

    // The flag name alone is still allowed out — and only when flag-shaped.
    const equalsForm = failureFor([`--data=${secret}`]);
    expect(equalsForm.message).toBe('unknown option --data');
    expect(equalsForm.argument).toBe('--data');

    const notFlagShaped = failureFor([`--${secret}=x`]);
    expect(notFlagShaped.message).toBe('unknown option');
    expect(notFlagShaped.argument).toBeUndefined();
  });

  it('caps an echoed flag name at 64 characters and drops anything longer', () => {
    const atCap = `--${'a'.repeat(62)}`;
    expect(atCap).toHaveLength(64);
    expect(failureFor([atCap]).message).toBe(`unknown option ${atCap}`);
    expect(failureFor([atCap]).argument).toBe(atCap);

    const justOver = `--${'a'.repeat(63)}`;
    const long = `--${'a'.repeat(298)}`;
    expect(long).toHaveLength(300);

    const bounded = failureFor([long]);
    expect(failureFor([justOver]).message).toBe('unknown option');
    expect(bounded.argument).toBeUndefined();
    expect(bounded.message).not.toContain(long);
    expect(bounded.message.length).toBeLessThanOrEqual('unknown option '.length + 64);
  });
});
