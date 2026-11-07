import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWLIST_SCHEMA_VERSION,
  DEFAULT_PUBLIC_ALLOWLIST,
  DEFAULT_PUBLIC_EXCLUSIONS,
  findMissingRequiredPaths,
  PHASE7_REQUIRED_TREE,
  REQUIRED_TREE_SCHEMA_VERSION,
  STRUCTURAL_GAPS,
} from './public-repo-allowlist.mjs';
import { buildPublicRepositoryManifest } from '../extract-public-repo.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-repo-allowlist-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('public repository allowlist configuration', () => {
  it('declares versioned schemas for both the allowlist and the required tree', () => {
    expect(typeof ALLOWLIST_SCHEMA_VERSION).toBe('string');
    expect(ALLOWLIST_SCHEMA_VERSION.length).toBeGreaterThan(0);
    expect(typeof REQUIRED_TREE_SCHEMA_VERSION).toBe('string');
    expect(REQUIRED_TREE_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it('aligns the default allowlist with the approved Phase 7 tree for paths that already exist', () => {
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('.github/workflows');
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('ATTRIBUTIONS.md');
    expect(DEFAULT_PUBLIC_ALLOWLIST).toEqual(expect.arrayContaining([
      'CODEOWNERS', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'GOVERNANCE.md',
      'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'examples',
    ]));
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('pipeline');
    expect(DEFAULT_PUBLIC_ALLOWLIST).toContain('packages');
  });

  it('lists the full Phase 7 root/top-level tree with a path and description for each entry', () => {
    const paths = PHASE7_REQUIRED_TREE.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining([
      'examples', 'packages/scanner-cli', 'CODEOWNERS', 'GOVERNANCE.md',
      'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'CODE_OF_CONDUCT.md',
    ]));
    for (const entry of PHASE7_REQUIRED_TREE) {
      expect(typeof entry.path).toBe('string');
      expect(entry.path.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('reports every Phase 7 required path missing from a workspace, sorted, and nothing that exists', () => {
    const root = fixture();
    write(root, 'README.md', '# hello\n');
    write(root, 'LICENSE', 'MIT\n');

    const missing = findMissingRequiredPaths(root);
    const missingPaths = missing.map((entry) => entry.path);

    expect(missingPaths).not.toContain('README.md');
    expect(missingPaths).not.toContain('LICENSE');
    expect(missingPaths).toContain('CODEOWNERS');
    expect(missingPaths).toContain('examples');
    expect(missingPaths).toContain('packages/scanner-cli');
    expect(missingPaths).toEqual([...missingPaths].sort());
    for (const entry of missing) expect(typeof entry.description).toBe('string');
  });

  it('stops reporting a required path once it is created', () => {
    const root = fixture();
    write(root, 'CODEOWNERS', '* @owner\n');

    const missing = findMissingRequiredPaths(root).map((entry) => entry.path);

    expect(missing).not.toContain('CODEOWNERS');
    expect(missing).toContain('GOVERNANCE.md');
  });

  it('reports no structural gap now that the standalone CLI path exists', () => {
    expect(STRUCTURAL_GAPS).toEqual([]);
  });

  it('declares acquired workflow fixture trees as explicit public-extraction exclusions', () => {
    expect(DEFAULT_PUBLIC_EXCLUSIONS).toEqual(expect.arrayContaining([
      'app/src/scanner/__fixtures__/calibration-corpus',
      'packages/scanner-cli/dist', 'packages/scanner-core/node_modules',
      'app/app/public',
      'contracts/tsconfig.tsbuildinfo',
      'pipeline/__fixtures__/make-entry.d.ts',
      'pipeline/reports',
    ]));
  });

  it('excludes generated public assets and internal corpus reports while keeping real source and fixtures', () => {
    const root = fixture();
    write(root, 'app/app/page.tsx', 'export default function Page() { return null; }\n');
    write(root, 'app/app/public/og/og-generic-LOW.png', 'generated');
    write(root, 'app/app/public/robots.txt', 'User-agent: *\n');
    write(root, 'app/app/public/sitemap-core.xml', '<urlset/>\n');
    write(root, 'contracts/scanner-result.ts', 'export {};\n');
    write(root, 'contracts/tsconfig.tsbuildinfo', '{"generated":true}\n');
    write(root, 'pipeline/__fixtures__/make-entry.ts', 'export {};\n');
    write(root, 'pipeline/__fixtures__/make-entry.d.ts', 'export {};\n');
    write(root, 'pipeline/__fixtures__/real-fixture.json', '{}\n');
    write(root, 'pipeline/run-enrichment.ts', 'export {};\n');
    write(root, 'pipeline/reports/corpus-test-poison.md', '# internal\n');

    const manifest = buildPublicRepositoryManifest({
      repositoryRoot: root,
      selectedOnly: true,
      enforceRequiredTree: false,
    });
    const paths = manifest.files.map((file) => file.path);

    expect(paths).toContain('app/app/page.tsx');
    expect(paths).toContain('contracts/scanner-result.ts');
    expect(paths).toContain('pipeline/__fixtures__/make-entry.ts');
    expect(paths).toContain('pipeline/__fixtures__/real-fixture.json');
    expect(paths).toContain('pipeline/run-enrichment.ts');
    expect(paths).not.toContain('app/app/public/og/og-generic-LOW.png');
    expect(paths).not.toContain('app/app/public/robots.txt');
    expect(paths).not.toContain('app/app/public/sitemap-core.xml');
    expect(paths).not.toContain('contracts/tsconfig.tsbuildinfo');
    expect(paths).not.toContain('pipeline/__fixtures__/make-entry.d.ts');
    expect(paths).not.toContain('pipeline/reports/corpus-test-poison.md');
  });
});
