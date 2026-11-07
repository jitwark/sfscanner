import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

export type V2SourceFileRecord = Readonly<{ path: string; sha256: string }>;

const SOURCE_ROOTS = ['pipeline', 'packages/scanner-core/src', 'contracts'] as const;
const REQUIRED_SOURCE_FILES = [
  'pipeline/build-corpus.ts',
  'pipeline/corpus/scan-stage.ts',
  'pipeline/scan/v2-fast-forward.ts',
  'pipeline/scan/v2-source-receipt.ts',
  'pipeline/scan/v2-corpus-adapter.ts',
  'pipeline/scan/v2-security-summary.ts',
  'packages/scanner-core/src/v2/scan-workflow.ts',
  'contracts/scanner-v2-result.ts',
] as const;
const REQUIRED_CONFIG_FILES = [
  'package.json',
  'pipeline/package.json',
  'pipeline/tsconfig.json',
  'pipeline/sources.json',
  'pipeline/config/n8n-compatibility-target.json',
  'packages/scanner-core/package.json',
  'packages/scanner-core/tsconfig.json',
  'contracts/package.json',
  'contracts/tsconfig.json',
] as const;
const SKIPPED_DIRECTORIES = new Set(['.git', '.types', '.work', '__fixtures__', 'node_modules', 'reports']);
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx']);
const TEST_FILE = /(?:\.test|\.spec|\.d)\.(?:cjs|cts|js|mjs|mts|ts|tsx)$/;

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message: string): never {
  throw new TypeError(`Source receipt cannot be built: ${message}.`);
}

async function checkedPath(root: string, identity: string, kind: string) {
  const parts = identity.split('/');
  let currentPath = root;
  for (const [index, part] of parts.entries()) {
    currentPath = join(currentPath, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(currentPath);
    } catch {
      return fail(`${kind} ${identity} is missing or unreadable`);
    }
    const component = parts.slice(0, index + 1).join('/');
    if (info.isSymbolicLink()) return fail(`symlink in ${kind} path ${component}`);
    if (index < parts.length - 1 && !info.isDirectory()) return fail(`${kind} path ${component} is not a directory`);
    if (index === parts.length - 1) return { filePath: currentPath, info };
  }
  return fail(`${kind} ${identity} has no path components`);
}

async function sourceRecord(root: string, identity: string, kind: string): Promise<V2SourceFileRecord> {
  const { filePath, info } = await checkedPath(root, identity, kind);
  if (!info.isFile()) return fail(`${kind} ${identity} is not a regular file`);
  try {
    return Object.freeze({ path: identity.replace(/\\/g, '/'), sha256: sha256(await readFile(filePath)) });
  } catch {
    return fail(`${kind} ${identity} is unreadable`);
  }
}

async function walkSourceDirectory(root: string, identity: string, requiredRoot = false): Promise<V2SourceFileRecord[]> {
  const kind = requiredRoot ? 'required source root' : 'source directory';
  const { filePath: dirPath, info } = await checkedPath(root, identity, kind);
  if (!info.isDirectory()) return fail(`source root ${identity} is not a directory`);

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return fail(`source directory ${identity} is unreadable`);
  }
  entries.sort(compareCanonicalStrings);
  const records: V2SourceFileRecord[] = [];
  for (const name of entries) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const childIdentity = `${identity}/${name}`;
    const { filePath, info: childInfo } = await checkedPath(root, childIdentity, 'source path');
    if (childInfo.isDirectory()) {
      records.push(...(await walkSourceDirectory(root, childIdentity)));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(name)) || TEST_FILE.test(name)) continue;
    if (!childInfo.isFile()) return fail(`source path ${childIdentity} is not a regular file`);
    try {
      records.push(Object.freeze({ path: childIdentity.replace(/\\/g, '/'), sha256: sha256(await readFile(filePath)) }));
    } catch {
      return fail(`source file ${childIdentity} is unreadable`);
    }
  }
  return records;
}

export async function collectV2ScannerSourceFiles(root: string): Promise<readonly V2SourceFileRecord[]> {
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    rootInfo = await lstat(root);
  } catch {
    return fail('repository root is missing or unreadable');
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return fail('repository root is not a regular directory');

  const records: V2SourceFileRecord[] = [];
  for (const sourceRoot of SOURCE_ROOTS) records.push(...(await walkSourceDirectory(root, sourceRoot, true)));
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!records.some((record) => record.path === required)) await sourceRecord(root, required, 'required source file');
  }
  for (const config of REQUIRED_CONFIG_FILES) records.push(await sourceRecord(root, config, 'required config file'));
  return Object.freeze(
    [...new Map(records.map((record) => [record.path, record])).values()].sort((a, b) => compareCanonicalStrings(a.path, b.path)),
  );
}
