import { describe, expect, it } from 'vitest';
import { countLines, selectSourceFiles } from './check-file-size.mjs';

describe('file-size source selection', () => {
  it('counts the final line when a file has no trailing newline', () => {
    expect(countLines(`${'line\n'.repeat(200)}line`)).toBe(201);
  });

  it('does not count the empty segment after a trailing newline as a line', () => {
    expect(countLines('line\n')).toBe(1);
    expect(countLines('')).toBe(0);
  });

  it('includes non-ignored untracked packages and scripts in a full sweep', () => {
    expect(selectSourceFiles({
      all: true,
      tracked: ['app/tracked.ts'],
      untracked: [
        'packages/scanner-core/src/new-policy.ts',
        'scripts/new-check.mjs',
        'app/out/generated.ts',
        '../outside.ts',
      ],
    })).toEqual([
      'app/tracked.ts',
      'packages/scanner-core/src/new-policy.ts',
      'scripts/new-check.mjs',
    ]);
  });
});
