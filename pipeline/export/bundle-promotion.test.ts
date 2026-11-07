import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteReleaseBundle } from './bundle-promotion.js';

const cleanupRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function outputDir(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-promotion-'));
  cleanupRoots.push(parent);
  return path.join(parent, 'release');
}

function siblingEntries(target: string): string[] {
  return fs.readdirSync(path.dirname(target));
}

describe('promoteReleaseBundle', () => {
  it('creates the output directory for a first-time release with no previous bundle', () => {
    const target = outputDir();
    expect(fs.existsSync(target)).toBe(false);

    const result = promoteReleaseBundle(target, (stagingDir) => {
      fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1');
      return 'built';
    });

    expect(result).toBe('built');
    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v1');
    expect(fs.existsSync(`${target}.previous`)).toBe(false);
    expect(siblingEntries(target)).toEqual(['release']);
  });

  it('preserves the previous bundle at a sibling .previous directory after a successful promotion', () => {
    const target = outputDir();
    promoteReleaseBundle(target, (stagingDir) => {
      fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1');
    });

    promoteReleaseBundle(target, (stagingDir) => {
      fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v2');
    });

    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v2');
    expect(fs.readFileSync(path.join(`${target}.previous`, 'artifact.txt'), 'utf8')).toBe('v1');
    expect(siblingEntries(target).sort()).toEqual(['release', 'release.previous']);
  });

  it('rotates .previous to hold only the immediately prior bundle, not every generation', () => {
    const target = outputDir();
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1'));
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v2'));
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v3'));

    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v3');
    expect(fs.readFileSync(path.join(`${target}.previous`, 'artifact.txt'), 'utf8')).toBe('v2');
    expect(siblingEntries(target).sort()).toEqual(['release', 'release.previous']);
  });

  it('leaves the visible directory untouched and cleans up staging when the build throws', () => {
    const target = outputDir();
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1'));

    expect(() => promoteReleaseBundle(target, () => {
      throw new Error('simulated build failure');
    })).toThrow('simulated build failure');

    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v1');
    expect(siblingEntries(target)).toEqual(['release']);
  });

  it('leaves the visible directory untouched when displacing it for promotion fails', () => {
    const target = outputDir();
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1'));

    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated Windows lock: target directory is held open');
    });

    expect(() => promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v2')))
      .toThrow('simulated Windows lock');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v1');
    expect(siblingEntries(target)).toEqual(['release']);
  });

  it('restores the previous bundle when swapping the new bundle into place fails', () => {
    const target = outputDir();
    promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v1'));

    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated failure swapping the new bundle into place');
      return realRename(from, to);
    });

    expect(() => promoteReleaseBundle(target, (stagingDir) => fs.writeFileSync(path.join(stagingDir, 'artifact.txt'), 'v2')))
      .toThrow('simulated failure swapping the new bundle into place');

    // 1: displace outputDir -> temp; 2: staging -> outputDir (fails); 3: restore temp -> outputDir.
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(path.join(target, 'artifact.txt'), 'utf8')).toBe('v1');
    expect(siblingEntries(target)).toEqual(['release']);
  });
});
