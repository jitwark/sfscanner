import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PUBLIC_ALLOWLIST,
  PHASE7_REQUIRED_TREE,
  buildPublicRepositoryManifest,
  materializePublicRepository,
  renderPublicRepositoryManifest,
  runPublicRepositoryExtractionCli,
  validatePublicRepositoryManifest,
} from './extract-public-repo.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-repo-extract-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('public repository extraction manifest', () => {
  it('builds a deterministic manifest from an explicit allowlist without copying files', () => {
    const root = fixture();
    write(root, 'src/z.txt', 'z');
    write(root, 'src/a.txt', 'a');
    write(root, 'README.md', 'hello');

    const options = { repositoryRoot: root, allowlist: ['src', 'README.md'] };
    const first = buildPublicRepositoryManifest(options);
    const second = buildPublicRepositoryManifest(options);

    expect(first.ok).toBe(true);
    expect(first.files.map(({ path: file }) => file)).toEqual(['README.md', 'src/a.txt', 'src/z.txt']);
    expect(first).toEqual(second);
    expect(validatePublicRepositoryManifest(first)).toEqual({ ok: true, errors: [] });
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true);
    expect(renderPublicRepositoryManifest(first, { json: true })).toBe(`${JSON.stringify(first, null, 2)}\n`);
  });

  it('fails closed for missing allowlist entries and unexpected files', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');
    write(root, 'unreviewed.txt', 'do not copy');

    const result = buildPublicRepositoryManifest({
      repositoryRoot: root,
      allowlist: ['README.md', 'missing.txt'],
    });

    expect(result.ok).toBe(false);
    expect(result.files.map(({ path: file }) => file)).toEqual(['README.md']);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'missing-allowlist-path:missing.txt',
      'unexpected-path:unreviewed.txt',
    ]);
  });

  it('supports an explicit selected-only extraction mode for a monorepo source root', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');
    write(root, 'unreviewed.txt', 'do not copy');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md'], selectedOnly: true });

    expect(result.ok).toBe(true);
    expect(result.files.map(({ path: file }) => file)).toEqual(['README.md']);
    expect(result.issues).toEqual([]);
  });

  it('denies secrets, Firebase state, backups, outputs, and generated corpus paths', () => {
    const root = fixture();
    for (const relativePath of [
      '.env.local',
      'credentials.json',
      'firebase.txt',
      '.firebase/state.json',
      'backups/old.json',
      'app/out/index.html',
      'pipeline/.work/run.json',
      'data/full-corpus.json',
    ]) write(root, relativePath, 'blocked');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['.'] });

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'denied-path:.env.local',
      'denied-path:.firebase',
      'denied-path:app/out',
      'denied-path:backups',
      'denied-path:credentials.json',
      'denied-path:data',
      'denied-path:firebase.txt',
      'denied-path:pipeline/.work',
    ]);
  });

  it('admits a source directory named like secret material while still denying secret files', () => {
    const root = fixture();
    // `packages/scanner-core/src/analyzers/secrets/` holds the provider-token
    // registry three shipped modules import. Denying the *directory* by name
    // denied the public tree a file it cannot compile without; a *file* called
    // credentials.json is still material and still denied.
    write(root, 'packages/scanner-core/src/analyzers/secrets/provider-token-registry.ts', 'export const version = 1;\n');
    write(root, 'config/credentials.json', '{"token":"placeholder"}\n');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['packages', 'config'] });

    expect(result.files.map(({ path: file }) => file)).toEqual([
      'packages/scanner-core/src/analyzers/secrets/provider-token-registry.ts',
    ]);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'denied-path:config/credentials.json',
    ]);
  });

  it('rejects traversal and absolute allowlist entries', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');

    const result = buildPublicRepositoryManifest({
      repositoryRoot: root,
      allowlist: ['../outside', path.join(root, 'README.md')],
    });

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'invalid-allowlist-path:../outside',
      `invalid-allowlist-path:${path.join(root, 'README.md')}`,
      'unexpected-path:README.md',
    ]);
  });

  it('rejects a symlink that escapes the repository', () => {
    const root = fixture();
    const outside = fixture();
    write(outside, 'secret.txt', 'secret');
    write(root, 'src/keep.txt', 'keep');
    const link = path.join(root, 'src', 'external');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return;
    }

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['src'] });

    expect(result.ok).toBe(false);
    expect(result.files.map(({ path: file }) => file)).toEqual(['src/keep.txt']);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'symlink-escape', path: 'src/external' }));
    expect(result.files.some(({ path: file }) => file.includes('secret.txt'))).toBe(false);
  });

  it('validates manifest ordering and rejects tampering', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');
    write(root, 'src.txt', 'source');
    const manifest = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md', 'src.txt'] });
    const tampered = { ...manifest, files: [...manifest.files].reverse() };

    expect(validatePublicRepositoryManifest(tampered).ok).toBe(false);
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('app/src');
  });

  it('includes the scanner-core workspace and root runtime tooling in the default allowlist', () => {
    expect(DEFAULT_PUBLIC_ALLOWLIST).toEqual(expect.arrayContaining(['packages', 'scripts']));

    const root = fixture();
    write(root, 'packages/scanner-core/package.json', '{"name":"@hub/scanner-core"}\n');
    write(root, 'packages/scanner-core/src/engine.ts', 'export const engine = true;\n');
    write(root, 'scripts/build-app.mjs', 'export const build = true;\n');
    write(root, 'scripts/check-file-size.mjs', 'export const check = true;\n');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['packages', 'scripts'] });

    expect(result.ok).toBe(true);
    expect(result.files.map(({ path: file }) => file)).toEqual([
      'packages/scanner-core/package.json',
      'packages/scanner-core/src/engine.ts',
      'scripts/build-app.mjs',
      'scripts/check-file-size.mjs',
    ]);
  });

  it('uses explicit public documentation paths instead of wholesale docs or openspec entries', () => {
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('docs');
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('openspec');
    expect(DEFAULT_PUBLIC_ALLOWLIST).toEqual(expect.arrayContaining([
      'docs/ARCHITECTURE.md',
      'docs/CLI.md',
      'docs/CONTENT-CONTRACT.md',
      'docs/DATA-LIFECYCLE.md',
      'docs/DATA-RELEASE-RETENTION.md',
      'docs/SECURITY.md',
      'docs/privacy.md',
      'docs/sources.md',
      'docs/takedown.md',
    ]));
  });

  it('selects the scanner documentation as a directory, deliberately', () => {
    // Every other docs entry is one explicit file, because `docs/` holds audit
    // packets, legal analysis and pre-decisional plans that must never ship.
    // `docs/scanner/` is different: everything in it is written for the public,
    // and enumerating it meant four documents added in one day silently failed
    // to publish. The deny rules still exclude docs/audit, docs/legal,
    // docs/recovery and docs/research regardless of the allowlist.
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('docs/scanner');
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('docs/decisions');
    for (const enumerated of [
      'docs/scanner/policy-inventory.md',
      'docs/scanner/rule-reference.md',
      'docs/scanner/threat-model.md',
    ]) {
      expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain(enumerated);
    }
  });

  it('does not confuse public legal UI code with internal legal decision documents', () => {
    const root = fixture();
    write(root, 'app/src/ui/legal/contact.tsx', 'export const contact = true;\n');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['app/src/ui/legal'] });

    expect(result.ok).toBe(true);
    expect(result.files.map(({ path: file }) => file)).toEqual(['app/src/ui/legal/contact.tsx']);
  });

  it('excludes acquired workflow fixture trees even when their source parent is allowlisted', () => {
    const root = fixture();
    write(root, 'app/src/scanner/engine.ts', 'export const engine = true;\n');
    write(root, 'app/src/scanner/__fixtures__/calibration-corpus/upstream.json', '{"Authorization":"Bearer live-secret-value"}\n');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['app/src'], selectedOnly: true });

    expect(result.ok).toBe(true);
    expect(result.files.map(({ path: file }) => file)).toEqual(['app/src/scanner/engine.ts']);
  });

  it('never includes private documentation trees even when they are explicitly allowlisted', () => {
    const root = fixture();
    write(root, 'docs/CLI.md', '# CLI\n');
    write(root, 'docs/audit/report.md', '# Internal audit report\n');
    write(root, 'docs/superpowers/plan.md', '# Internal plan\n');
    write(root, 'docs/legal/packet.md', '# Legal packet\n');
    write(root, 'docs/recovery/runbook.md', '# Recovery runbook\n');
    write(root, 'docs/research/notes.md', '# Private research\n');
    write(root, 'openspec/changes/example/tasks.md', '- [ ] incomplete\n');

    const result = buildPublicRepositoryManifest({
      repositoryRoot: root,
      allowlist: ['docs/CLI.md', 'docs/audit', 'docs/superpowers', 'docs/legal', 'docs/recovery', 'docs/research', 'openspec'],
    });

    expect(result.files.map(({ path: file }) => file)).toEqual(['docs/CLI.md']);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'denied-path:docs/audit',
      'denied-path:docs/legal',
      'denied-path:docs/recovery',
      'denied-path:docs/research',
      'denied-path:docs/superpowers',
      'denied-path:openspec',
    ]);
  });

  it('keeps CLI schema artifacts in the effective public allowlist and preserves manifest hashes when materialized', () => {
    const root = fixture();
    const schemaFiles = [
      ['pipeline/cli/schemas/emitted-sarif-2.1.0-profile.schema.json', '{"profile":true}\n'],
      ['pipeline/cli/schemas/scanner-cli-v1.schema.json', '{"schemaVersion":"scanner-cli-v1"}\n'],
    ];

    for (const [relativePath, content] of schemaFiles) write(root, relativePath, content);

    for (const [relativePath] of schemaFiles) {
      expect(DEFAULT_PUBLIC_ALLOWLIST.some((entry) => (
        entry === relativePath || relativePath.startsWith(`${entry}/`)
      ))).toBe(true);
    }

    const allowlist = DEFAULT_PUBLIC_ALLOWLIST.filter((entry) => entry === 'pipeline');
    const manifest = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist });
    const expectedRecords = schemaFiles.map(([relativePath, content]) => ({
      path: relativePath,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    })).sort((left, right) => left.path.localeCompare(right.path));

    expect(manifest).toMatchObject({ ok: true, allowlist: ['pipeline'] });
    expect(manifest.files).toEqual(expectedRecords);

    const destination = fixture();
    const materialized = materializePublicRepository({
      repositoryRoot: root,
      destinationRoot: path.join(destination, 'public-repo'),
      allowlist,
    });

    expect(materialized).toMatchObject({ ok: true, materialized: true });
    expect(materialized.verification).toMatchObject({ ok: true, files: expectedRecords });
    for (const [relativePath, content] of schemaFiles) {
      expect(fs.readFileSync(path.join(materialized.destinationRoot, relativePath), 'utf8')).toBe(content);
    }
  });

  it('fails closed when an allowlisted file contains a secret-like value', () => {
    const root = fixture();
    write(root, 'README.md', 'Use sk-proj-12345678901234567890 only in a local test.');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md'] });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-content', path: 'README.md' }));
    expect(JSON.stringify(result.issues)).not.toContain('sk-proj-12345678901234567890');
  });

  it('returns only JSON on the machine-readable CLI path', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');

    const result = runPublicRepositoryExtractionCli(['--root', root, '--allow', 'README.md', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, files: [{ path: 'README.md' }] });
  });

  it('accepts selected-only on the machine-readable CLI path', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');
    write(root, 'private.txt', 'not selected');

    const result = runPublicRepositoryExtractionCli(['--root', root, '--allow', 'README.md', '--selected-only', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, files: [{ path: 'README.md' }] });
  });

  it('leaves an explicit, narrow allowlist untouched by Phase 7 required-tree enforcement by default', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md'] });

    expect(result.ok).toBe(true);
    expect(result.requiredMissing).toEqual([]);
    expect(result.structuralGaps).toEqual([]);
  });

  it('reports every missing Phase 7 required path as named, fail-closed issues when required-tree enforcement is requested', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['README.md'], enforceRequiredTree: true });

    expect(result.ok).toBe(false);
    expect(result.requiredMissing.map((entry) => entry.path)).toEqual(expect.arrayContaining(['examples', 'packages/scanner-cli', 'CODEOWNERS']));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing-required-path', path: 'examples' }));
    expect(result.issues.some((entry) => entry.code === 'structural-gap')).toBe(false);
    expect(result.structuralGaps).toEqual([]);

    const destination = fixture();
    const materialized = materializePublicRepository({ repositoryRoot: root, destinationRoot: path.join(destination, 'out'), allowlist: ['README.md'], enforceRequiredTree: true });
    expect(materialized.materialized).toBe(false);
    expect(fs.existsSync(path.join(destination, 'out'))).toBe(false);
  });

  it('runs Phase 7 required-tree enforcement by default when the caller uses the real default allowlist', () => {
    const result = buildPublicRepositoryManifest({ repositoryRoot: '.' });

    // Generated catalogue data is deliberately outside the minimal public
    // source boundary; it is a release artifact, not a required source path.
    expect(result.files.map(({ path: file }) => file)).toContain('docs/LICENSING.md');
    expect(PHASE7_REQUIRED_TREE.map(({ path: file }) => file)).toContain('docs/LICENSING.md');
    expect(result.requiredMissing).toEqual([]);
    expect(result.issues.some((entry) => entry.code === 'missing-required-path')).toBe(false);
    expect(result.structuralGaps).toEqual([]);
  });

  it('suppresses only an exactly-matched exempted (path, rule) pair, never an entire file or directory', () => {
    const exemptOnlyRoot = fixture();
    write(exemptOnlyRoot, 'notes/canary.json', '{"value":"canaryFakeSecretKey"}');
    const contentExemptions = [
      { path: 'notes/canary.json', rule: 'canary-string', reason: 'documented synthetic canary fixture used only to test detection', evidence: 'literal canaryFakeSecretKey marker' },
    ];

    const exemptedOnly = buildPublicRepositoryManifest({ repositoryRoot: exemptOnlyRoot, allowlist: ['notes/canary.json'], contentExemptions });
    expect(exemptedOnly.ok).toBe(true);
    expect(exemptedOnly.contentExemptionSummary.appliedCount).toBe(1);

    const mixedRoot = fixture();
    write(mixedRoot, 'notes/canary.json', '{"value":"canaryFakeSecretKey"}');
    write(mixedRoot, 'notes/other.json', 'const secret = "sk-proj-12345678901234567890";');
    const withUnexempted = buildPublicRepositoryManifest({ repositoryRoot: mixedRoot, allowlist: ['notes'], contentExemptions });
    expect(withUnexempted.ok).toBe(false);
    expect(withUnexempted.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-content', path: 'notes/other.json' }));
    expect(withUnexempted.issues.some((entry) => entry.path === 'notes/canary.json')).toBe(false);
  });

  it('writes a classified issue report to disk and prints classified counts to stdout on the default (non-JSON) CLI path', () => {
    const root = fixture();
    write(root, 'README.md', 'hello');
    write(root, 'unreviewed.txt', 'do not copy');

    const result = runPublicRepositoryExtractionCli(['--root', root, '--allow', 'README.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Issue classification');
    expect(result.stdout).toContain('unexpected-path: 1');
    const reportPath = path.join(root, 'docs', 'public-repository', 'EXTRACTION-ISSUES.md');
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('unexpected-path');
  });

  it('includes only the prepared local action path, never private extraction state', () => {
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('.github/actions/scan/action.yml');
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('action.yml');
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('.github/actions');
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('outputs');
    expect(DEFAULT_PUBLIC_ALLOWLIST).not.toContain('.superpowers');
  });

  it('fails closed for npm credentials and deployment scripts even when a parent is allowlisted', () => {
    const root = fixture();
    write(root, '.npmrc', '//registry.example/:_authToken=placeholder\n');
    write(root, 'scripts/deploy-firebase-preview.mjs', 'export const deploy = true;\n');

    const result = buildPublicRepositoryManifest({ repositoryRoot: root, allowlist: ['.'] });

    expect(result.files).toEqual([]);
    expect(result.issues.map(({ code, path: issuePath }) => `${code}:${issuePath}`)).toEqual([
      'denied-path:.npmrc',
      'denied-path:scripts/deploy-firebase-preview.mjs',
    ]);
  });

});
