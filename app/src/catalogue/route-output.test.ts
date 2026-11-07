import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const outputRoot = path.resolve(process.cwd(), 'out');

describe('bounded hub export', () => {
  it('keeps large security and trigger documents below the static-host limit', () => {
    const routes = [
      path.join(outputRoot, 'security', 'medium', 'index.html'),
      path.join(outputRoot, 'triggers', 'schedule', 'index.html'),
    ];
    const missing = routes.filter((route) => !fs.existsSync(route));
    if (missing.length > 0) return;

    for (const route of routes) {
      expect(fs.statSync(route).size, route).toBeLessThan(2_000_000);
    }
  });
});
