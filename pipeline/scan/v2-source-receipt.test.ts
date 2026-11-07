import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildScannerSourceReceipt } from './v2-source-receipt.js';

const requiredFiles = [
  'package.json',
  'package-lock.json',
  'pipeline/package.json',
  'pipeline/tsconfig.json',
  'pipeline/sources.json',
  'pipeline/config/n8n-compatibility-target.json',
  'pipeline/build-corpus.ts',
  'pipeline/corpus/scan-stage.ts',
  'pipeline/scan/v2-fast-forward.ts',
  'pipeline/scan/v2-source-receipt.ts',
  'pipeline/scan/v2-corpus-adapter.ts',
  'pipeline/scan/v2-security-summary.ts',
  'packages/scanner-core/package.json',
  'packages/scanner-core/tsconfig.json',
  'packages/scanner-core/src/v2/scan-workflow.ts',
  'contracts/package.json',
  'contracts/tsconfig.json',
  'contracts/scanner-v2-result.ts',
] as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(options: { missingRoot?: string; missingFile?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'v2-source-receipt-'));
  roots.push(root);
  for (const directory of ['pipeline', 'packages/scanner-core/src', 'contracts']) {
    if (directory !== options.missingRoot) await mkdir(join(root, directory), { recursive: true });
  }
  for (const path of requiredFiles) {
    if (path === options.missingFile || path.split('/').slice(0, -1).join('/') === options.missingRoot) continue;
    const filePath = join(root, path);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, `${path}\n`, 'utf8');
  }
  return root;
}

describe('buildScannerSourceReceipt', () => {
  it('fails closed when a required source root is absent', async () => {
    const root = await makeRoot({ missingRoot: 'contracts' });
    await expect(buildScannerSourceReceipt({ rootDir: root })).rejects.toThrow(/required source root.*contracts/i);
  });

  it('fails closed when a required source file is absent or not a readable file', async () => {
    const missing = await makeRoot({ missingFile: 'pipeline/corpus/scan-stage.ts' });
    await expect(buildScannerSourceReceipt({ rootDir: missing })).rejects.toThrow(/required source file.*scan-stage/i);

    const missingConfig = await makeRoot({ missingFile: 'pipeline/config/n8n-compatibility-target.json' });
    await expect(buildScannerSourceReceipt({ rootDir: missingConfig })).rejects.toThrow(/required config file.*n8n-compatibility-target/i);

    const unreadable = await makeRoot({ missingFile: 'pipeline/scan/v2-fast-forward.ts' });
    await mkdir(join(unreadable, 'pipeline/scan/v2-fast-forward.ts'), { recursive: true });
    await expect(buildScannerSourceReceipt({ rootDir: unreadable })).rejects.toThrow(/required source file.*v2-fast-forward/i);
  });

  it('changes the source digest when production stages, adapters, or explicit configs change', async () => {
    const root = await makeRoot();
    const original = await buildScannerSourceReceipt({ rootDir: root });
    for (const path of [
      'pipeline/build-corpus.ts',
      'pipeline/corpus/scan-stage.ts',
      'pipeline/scan/v2-fast-forward.ts',
      'pipeline/scan/v2-source-receipt.ts',
      'pipeline/scan/v2-corpus-adapter.ts',
      'pipeline/scan/v2-security-summary.ts',
      'pipeline/config/n8n-compatibility-target.json',
      'pipeline/sources.json',
      'packages/scanner-core/src/v2/scan-workflow.ts',
      'contracts/scanner-v2-result.ts',
    ]) {
      const filePath = join(root, path);
      const bytes = await readFile(filePath);
      await writeFile(filePath, Buffer.concat([bytes, Buffer.from('\nchanged') ]));
      const changed = await buildScannerSourceReceipt({ rootDir: root });
      expect(changed.sourceBuildDigest, path).not.toBe(original.sourceBuildDigest);
      await writeFile(filePath, bytes);
    }
  });

  it('uses stable relative identities and keeps run IDs, timestamps, and inputs out of the source digest', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'pipeline/.work/run-a'), { recursive: true });
    await writeFile(join(root, 'pipeline/.work/run-a/volatile.ts'), 'volatile');
    const first = await buildScannerSourceReceipt({
      rootDir: root,
      runId: 'run-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      candidateInputs: [{ entryId: 'entry-a', inputSha256: 'a'.repeat(64) }],
    });
    const second = await buildScannerSourceReceipt({
      rootDir: root,
      runId: 'run-b',
      createdAt: '2026-02-01T00:00:00.000Z',
      candidateInputs: [{ entryId: 'entry-b', inputSha256: 'b'.repeat(64) }],
    });
    expect(first.sourceBuildDigest).toBe(second.sourceBuildDigest);
    expect(first.inputInventoryDigest).not.toBe(second.inputInventoryDigest);
    expect(first.sourceFiles.some((file) => file.path.includes('\\'))).toBe(false);
    expect(first.sourceFiles.some((file) => file.path.includes('.work'))).toBe(false);
  });

  it('does not follow symlinked source directories', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'v2-source-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'escape.ts'), 'outside');
    await symlink(outside, join(root, 'pipeline/external'), 'junction');
    await expect(buildScannerSourceReceipt({ rootDir: root })).rejects.toThrow(/symlink/i);

    const linkedRoot = join(outside, 'linked-root');
    await symlink(root, linkedRoot, 'junction');
    await expect(buildScannerSourceReceipt({ rootDir: linkedRoot })).rejects.toThrow(/repository root.*directory/i);
  });

  it('rejects an intermediate junction before reading a nested source root', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'v2-source-junction-'));
    roots.push(outside);
    const target = join(outside, 'packages');
    for (const path of requiredFiles.filter((item) => item.startsWith('packages/'))) {
      const externalPath = join(target, path.slice('packages/'.length));
      await mkdir(join(externalPath, '..'), { recursive: true });
      await writeFile(externalPath, `${path}\n`, 'utf8');
    }
    await rm(join(root, 'packages'), { recursive: true, force: true });
    await symlink(target, join(root, 'packages'), 'junction');
    await expect(buildScannerSourceReceipt({ rootDir: root })).rejects.toThrow(/symlink.*packages/i);
  });
});
