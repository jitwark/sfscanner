import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearExportOutput, selectBuildArgs } from './build-app.mjs';

describe('release app build bundler selection', () => {
  it('defaults to Webpack', () => {
    expect(selectBuildArgs([])).toEqual(['--webpack']);
    expect(selectBuildArgs(['--debug'])).toEqual(['--webpack', '--debug']);
  });

  it.each(['--webpack', '--turbo', '--turbopack'])('preserves explicit %s', (bundler) => {
    expect(selectBuildArgs([bundler])).toEqual([bundler]);
  });
});

describe('release app output cleanup', () => {
  it('clears only the generated app/out tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-build-output-'));
    try {
      const output = path.join(root, 'app', 'out');
      fs.mkdirSync(path.join(output, 'w', 'fixture'), { recursive: true });
      fs.writeFileSync(path.join(output, 'w', 'fixture', 'index.html'), 'old');
      fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{}');

      clearExportOutput(root);

      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(path.join(root, 'app', 'src'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('succeeds when app/out is already absent, which is the state it wants', () => {
    // A fresh clone has no `app/out`, and so does a checkout whose previous
    // build failed partway. `lstatSync` threw ENOENT and the catch reported
    // "Refusing to clean app/out", which reads like a safety refusal and is
    // really the desired end state — the build could not start at all.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-build-output-'));
    try {
      fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{}');

      expect(() => clearExportOutput(root)).not.toThrow();
      expect(fs.existsSync(path.join(root, 'app', 'out'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still refuses when app/out is a symbolic link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-build-output-'));
    try {
      fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      try {
        fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'app', 'out'), 'junction');
      } catch {
        return; // unprivileged Windows cannot create links; the guard is unchanged
      }
      expect(() => clearExportOutput(root)).toThrow(/symbolic link/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a root that cannot contain the generated app/out target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-build-output-'));
    try {
      expect(() => clearExportOutput(root)).toThrow(/app[\\/]out/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns a cleanup failure into an actionable build error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-build-output-'));
    try {
      fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'app', 'out'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      expect(() => clearExportOutput(root, () => { throw new Error('simulated lock'); }))
        .toThrow(/Unable to clean app[\\/]out.*simulated lock/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
