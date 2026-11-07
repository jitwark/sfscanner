import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAtomicFile, writeAtomicFileWithWriter } from './atomic-file.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function outputPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-atomic-file-'));
  directories.push(directory);
  return path.join(directory, 'artifact.txt');
}

describe('atomic export files', () => {
  it('writes a new target and replaces it with complete bytes', () => {
    const target = outputPath();

    writeAtomicFile(target, 'first');
    writeAtomicFile(target, 'second');

    expect(fs.readFileSync(target, 'utf8')).toBe('second');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['artifact.txt']);
  });

  it('preserves the previous target and cleans staging after writer failure', () => {
    const target = outputPath();
    writeAtomicFile(target, 'previous');

    expect(() => writeAtomicFileWithWriter(target, () => {
      throw new Error('simulated export failure');
    })).toThrow('simulated export failure');
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['artifact.txt']);
  });

  it('rejects a writer that emits a directory and preserves the previous target', () => {
    const target = outputPath();
    writeAtomicFile(target, 'previous');

    expect(() => writeAtomicFileWithWriter(target, (temporaryPath) => {
      fs.mkdirSync(temporaryPath);
    })).toThrow(/regular file/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('previous');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['artifact.txt']);
  });

  it('fsyncs the written bytes before the rename that makes them visible', () => {
    const target = outputPath();
    const fsync = vi.spyOn(fs, 'fsyncSync');

    writeAtomicFile(target, 'durable');

    expect(fsync).toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('durable');
    fsync.mockRestore();
  });

  it('refuses to replace an existing directory target', () => {
    const target = outputPath();
    fs.mkdirSync(target);

    expect(() => writeAtomicFile(target, 'new')).toThrow(/regular file/i);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['artifact.txt']);
  });
});
