/**
 * Command-line surface for `scripts/export-public-dataset.ts`.
 *
 * The option set is closed and every option requires a value, so a bare
 * `--out`, a value that is really the next flag, an unknown or repeated
 * option, and a `--generated-at` that is not an exact ISO timestamp all fail
 * here — before the driver logs, reads the corpus, or opens the bundle for
 * writing.
 *
 * Path semantics are the driver's historical ones: an explicitly supplied
 * path resolves against the process cwd (`path.resolve(value)`), while the
 * defaults are repo-relative, so the script works from any cwd but a caller
 * that names a directory keeps meaning what it always meant.
 */
import path from 'node:path';

export type PublicDatasetArguments = {
  dataDir: string;
  outputDir: string;
  generatedAt?: string;
};

/**
 * What may be echoed back from argv: a flag name, never a value, and at most
 * 64 characters (`--` plus 62) — the same bound the scanner CLI's `failure()`
 * applies before it echoes an argument.
 */
const FLAG_SHAPED = /^--[a-z][a-z0-9-]{0,61}$/;

/**
 * The one error a malformed command line produces. Callers catch this type
 * rather than matching message text: the message names the offending option
 * and never quotes a supplied value, which may be arbitrary operator input.
 */
export class PublicDatasetUsageError extends Error {
  /** The offending flag, and only when flag-shaped: a token that carries a value never reaches this field. */
  readonly argument?: string;

  constructor(message: string, argument?: string) {
    super(message);
    this.name = 'PublicDatasetUsageError';
    this.argument = argument !== undefined && FLAG_SHAPED.test(argument) ? argument : undefined;
  }
}

const VALUE_OPTIONS = ['--data', '--out', '--generated-at'] as const;

type ValueOption = (typeof VALUE_OPTIONS)[number];

const isValueOption = (token: string): token is ValueOption => (VALUE_OPTIONS as readonly string[]).includes(token);

/** The flag name a token declares: everything before its first `=`, if any. */
const flagNameOf = (token: string): string => {
  const equals = token.indexOf('=');
  return equals === -1 ? token : token.slice(0, equals);
};

const isExactIsoTimestamp = (value: string): boolean => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export function parsePublicDatasetArguments(argv: readonly string[], repoRoot: string): PublicDatasetArguments {
  // Doubles as the seen set: a supplied value is never `undefined`, so an
  // occupied slot is a repeated option.
  const supplied: Record<ValueOption, string | undefined> = {
    '--data': undefined,
    '--out': undefined,
    '--generated-at': undefined,
  };

  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!isValueOption(token)) {
      if (!token.startsWith('--')) throw new PublicDatasetUsageError('unexpected non-option argument');
      // `--flag=value` declares a flag like any other: echo the bare name when
      // it is flag-shaped, and nothing at all when it is not.
      const name = flagNameOf(token);
      throw FLAG_SHAPED.test(name)
        ? new PublicDatasetUsageError(`unknown option ${name}`, name)
        : new PublicDatasetUsageError('unknown option');
    }
    if (supplied[token] !== undefined) {
      throw new PublicDatasetUsageError(`${token} was supplied more than once`, token);
    }

    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new PublicDatasetUsageError(`${token} requires a value`, token);
    }
    supplied[token] = value;
  }

  const generatedAt = supplied['--generated-at'];
  if (generatedAt !== undefined && !isExactIsoTimestamp(generatedAt)) {
    throw new PublicDatasetUsageError(
      '--generated-at must be an exact ISO-8601 timestamp, e.g. 2026-01-01T00:00:00.000Z',
      '--generated-at',
    );
  }

  return {
    dataDir: path.resolve(supplied['--data'] ?? path.join(repoRoot, 'data')),
    outputDir: path.resolve(supplied['--out'] ?? path.join(repoRoot, 'outputs', 'public-dataset')),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  };
}
