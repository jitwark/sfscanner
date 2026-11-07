import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
export const retainedHash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

function boundedArchive(file, sealed = false) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || (sealed && before.nlink !== 1)
    || before.size === 0 || before.size > MAX_RETAINED_BYTES) throw new Error('Retained archive must be a nonempty bounded regular file');
  const descriptor = openSync(file, 'r');
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Retained archive changed before read');
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) throw new Error('Retained archive truncated'); offset += count; }
    const after = fstatSync(descriptor); const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || (sealed && named.nlink !== 1) || named.ino !== opened.ino || named.dev !== opened.dev
      || after.size !== opened.size || named.size !== opened.size) throw new Error('Retained archive changed during read');
    return bytes;
  } finally { closeSync(descriptor); }
}

export function readRetainedOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!['--tarball', '--sha256', '--sri', '--expected-version'].includes(key)
      || values.has(key) || typeof value !== 'string' || value.startsWith('--')) throw new Error('Invalid retained CLI option: ' + key);
    values.set(key, value);
  }
  const tarball = values.get('--tarball'); const version = values.get('--expected-version');
  if (!tarball || !path.isAbsolute(tarball) || tarball.includes('\0')) throw new Error('--tarball must name an absolute existing archive');
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('--expected-version must be an exact version');
  const sha256 = values.get('--sha256'); const sri = values.get('--sri');
  if (Boolean(sha256) === Boolean(sri)) throw new Error('Provide exactly one of --sha256 or --sri');
  if (sha256 && !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid SHA-256');
  if (sri) {
    const encoded = sri.slice(7); const bytes = Buffer.from(encoded, 'base64');
    if (!sri.startsWith('sha512-') || bytes.length !== 64 || bytes.toString('base64') !== encoded) throw new Error('Invalid SHA-512 SRI');
  }
  return Object.freeze({ tarball: path.resolve(tarball), expectedVersion: version, sha256, sri });
}

export function sealRetainedTarball(options, workRoot) {
  const bytes = boundedArchive(options.tarball);
  const sha256 = retainedHash(bytes); const sri = 'sha512-' + retainedHash(bytes, 'sha512');
  if ((options.sha256 && options.sha256 !== sha256) || (options.sri && options.sri !== sri)) throw new Error('Retained archive digest mismatch');
  const sealedPath = path.join(workRoot, 'retained.tgz');
  writeFileSync(sealedPath, bytes, { flag: 'wx', mode: 0o400 });
  const seal = Object.freeze({ originalPath: options.tarball, sealedPath, bytes: bytes.length, sha256, sri });
  assertRetainedSeal(seal);
  return seal;
}

export function assertRetainedSeal(seal) {
  const bytes = boundedArchive(seal.sealedPath, true);
  if (bytes.length !== seal.bytes || retainedHash(bytes) !== seal.sha256 || 'sha512-' + retainedHash(bytes, 'sha512') !== seal.sri) throw new Error('Sealed retained archive changed');
  return true;
}

export function assertRetainedManifest(manifest, version) {
  if (manifest.name !== 'sfscanner' || manifest.version !== version || manifest.type !== 'module') throw new Error('Installed retained package identity mismatch');
  if (!['>=22 <23', '>=22.0.0 <23.0.0', '^22.0.0', '22.x'].includes(manifest.engines?.node)) throw new Error('Retained Node engine contract mismatch');
  if (manifest.imports?.['#sfscanner-worker'] !== './dist/scan-worker.js') throw new Error('Retained private worker mapping mismatch');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (manifest[field] && Object.keys(manifest[field]).length !== 0) throw new Error('Self-contained package declares runtime dependencies: ' + field);
  }
  if (JSON.stringify(Object.keys(manifest.bin ?? {}).sort()) !== JSON.stringify(['sfscanner', 'sfscanner-mcp'])) throw new Error('Retained package binary contract mismatch');
  if (manifest.bin.sfscanner.replace(/^\.\//u, '') !== 'dist/main.js' || manifest.bin['sfscanner-mcp'].replace(/^\.\//u, '') !== 'dist/mcp.js') throw new Error('Retained binary target mismatch');
  const required = ['.', './v2/arguments', './v2/cli-runner', './v2/help', './v2/metadata-output', './v2/preflight-readiness', './v2/privacy-prepare'];
  if (JSON.stringify(Object.keys(manifest.exports ?? {}).sort()) !== JSON.stringify(required.sort())) throw new Error('Retained package export contract mismatch');
  for (const key of required) {
    const stem = key === '.' ? 'index' : key.slice(2);
    const target = manifest.exports[key];
    if (target?.import !== `./dist/${stem}.js` || target?.types !== `./dist/${stem}.d.ts`
      || JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(['import', 'types'])) throw new Error('Retained export target mismatch');
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook] !== undefined) throw new Error('Retained package contains an installation hook');
  }
  return true;
}

export function assertRetainedNotices(license, notices) {
  const text = license.toString().replace(/\s+/gu, ' ');
  for (const clause of ['Permission is hereby granted, free of charge', 'The above copyright notice and this permission notice', 'THE SOFTWARE IS PROVIDED "AS IS"', 'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS']) {
    if (!text.includes(clause)) throw new Error('Retained MIT license content is incomplete');
  }
  for (const name of ['@humanwhocodes/momoa', '@noble/hashes', '@hub/contracts', '@hub/scanner-core']) {
    if (!notices.toString().includes(name)) throw new Error('Retained notices omit ' + name);
  }
  return true;
}
