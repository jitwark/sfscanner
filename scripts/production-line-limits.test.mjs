import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const targets = [
  'measure-baseline.mjs',
  'check-scanner-core.mjs',
  path.join('lib', 'public-repo-materializer.mjs'),
];

describe('script production file size', () => {
  it('keeps the structural-cleanup targets at or below 250 lines', () => {
    for (const target of targets) {
      const file = path.join(import.meta.dirname, target);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      expect(lines.length, target).toBeLessThanOrEqual(250);
    }
  });
});
