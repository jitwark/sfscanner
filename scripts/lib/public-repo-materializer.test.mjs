import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPublicRepositoryManifest,
  materializePublicRepository,
  runPublicRepositoryExtractionCli,
  verifyPublicRepositoryMaterialization,
} from '../extract-public-repo.mjs';
import { materializePublicRepositoryFromManifest } from './public-repo-materializer.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-repo-materialize-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('public repository materialization', () => {
  it('materializes a validated allowlist and verifies the exact selected tree', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    const destination = path.join(parent, 'public-repo');
    write(root, 'README.md', 'hello');
    write(root, 'src/index.ts', 'export const value = 1;');

    const result = materializePublicRepository({ repositoryRoot: root, destinationRoot: destination, allowlist: ['src', 'README.md'] });

    expect(result).toMatchObject({ ok: true, materialized: true, destinationRoot: path.resolve(destination) });
    expect(fs.readFileSync(path.join(destination, 'README.md'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(destination, 'src/index.ts'), 'utf8')).toContain('value');
    expect(result.verification).toMatchObject({ ok: true, files: [{ path: 'README.md' }, { path: 'src/index.ts' }] });
  });

  it('detects tampered, missing, and unexpected destination contents', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    write(root, 'README.md', 'hello');
    write(root, 'src/index.ts', 'source');
    const makeCopy = (name) => materializePublicRepository({
      repositoryRoot: root, destinationRoot: path.join(parent, name), allowlist: ['README.md', 'src'],
    });

    const tampered = makeCopy('tampered');
    fs.writeFileSync(path.join(parent, 'tampered', 'README.md'), 'changed');
    expect(verifyPublicRepositoryMaterialization({ destinationRoot: path.join(parent, 'tampered'), manifest: tampered }).issues)
      .toContainEqual(expect.objectContaining({ code: 'destination-hash-mismatch', path: 'README.md' }));

    const missing = makeCopy('missing');
    fs.rmSync(path.join(parent, 'missing', 'src', 'index.ts'));
    expect(verifyPublicRepositoryMaterialization({ destinationRoot: path.join(parent, 'missing'), manifest: missing }).issues)
      .toContainEqual(expect.objectContaining({ code: 'missing-destination-file', path: 'src/index.ts' }));

    const unexpected = makeCopy('unexpected');
    write(path.join(parent, 'unexpected'), 'extra.txt', 'unselected');
    expect(verifyPublicRepositoryMaterialization({ destinationRoot: path.join(parent, 'unexpected'), manifest: unexpected }).issues)
      .toContainEqual(expect.objectContaining({ code: 'unexpected-destination-file', path: 'extra.txt' }));
  });

  it('rejects an existing destination and source/destination overlap without touching either', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    write(root, 'README.md', 'source');
    const existing = path.join(parent, 'existing');
    write(existing, 'keep.txt', 'keep');
    const existingResult = materializePublicRepository({ repositoryRoot: root, destinationRoot: existing, allowlist: ['README.md'] });
    expect(existingResult.ok).toBe(false);
    expect(existingResult.issues).toContainEqual(expect.objectContaining({ code: 'destination-exists' }));
    expect(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8')).toBe('keep');

    const empty = path.join(parent, 'empty');
    fs.mkdirSync(empty);
    const emptyResult = materializePublicRepository({ repositoryRoot: root, destinationRoot: empty, allowlist: ['README.md'] });
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.issues).toContainEqual(expect.objectContaining({ code: 'destination-exists' }));

    const overlap = path.join(root, 'output');
    const overlapResult = materializePublicRepository({ repositoryRoot: root, destinationRoot: overlap, allowlist: ['README.md'] });
    expect(overlapResult.ok).toBe(false);
    expect(overlapResult.issues).toContainEqual(expect.objectContaining({ code: 'destination-overlap' }));
    expect(fs.existsSync(overlap)).toBe(false);
  });

  it('rejects a symlink in the destination parent', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    const outside = fixture();
    write(root, 'README.md', 'source');
    const linkedParent = path.join(parent, 'linked-parent');
    try { fs.symlinkSync(outside, linkedParent, 'junction'); } catch { return; }

    const result = materializePublicRepository({
      repositoryRoot: root, destinationRoot: path.join(linkedParent, 'public'), allowlist: ['README.md'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'destination-symlink-parent' }));
    expect(fs.existsSync(path.join(outside, 'public'))).toBe(false);
  });

  it('rejects a selected source file that changed after manifest creation before copying', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    const destination = path.join(parent, 'public-repo');
    write(root, 'README.md', 'manifest version');
    const manifest = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md'] });
    fs.writeFileSync(path.join(root, 'README.md'), 'changed after manifest creation');

    const result = materializePublicRepositoryFromManifest({ repositoryRoot: root, destinationRoot: destination, manifest });

    expect(result.ok).toBe(false);
    expect(result.materialized).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source-hash-mismatch', path: 'README.md' }));
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('supports materialization through the CLI while audit mode never creates a destination', () => {
    const parent = fixture();
    const root = path.join(parent, 'source');
    const destination = path.join(parent, 'public-repo');
    const auditDestination = path.join(parent, 'audit-output');
    write(root, 'README.md', 'hello');

    const materialized = runPublicRepositoryExtractionCli(['--root', root, '--allow', 'README.md', '--materialize', destination, '--json']);
    expect(materialized.exitCode).toBe(0);
    expect(JSON.parse(materialized.stdout)).toMatchObject({ ok: true, materialized: true });
    expect(fs.existsSync(path.join(destination, 'README.md'))).toBe(true);

    const audit = runPublicRepositoryExtractionCli(['--root', root, '--allow', 'README.md', '--json']);
    expect(audit.exitCode).toBe(0);
    expect(JSON.parse(audit.stdout)).not.toHaveProperty('materialized');
    expect(fs.existsSync(auditDestination)).toBe(false);
  });
});
