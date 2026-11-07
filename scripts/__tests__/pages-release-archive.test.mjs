import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createArchive,
  inspectArchive,
  verifyArchive,
} from '../pages-release-tar.mjs';
import { open } from 'node:fs/promises';

const FIXTURE_SHA256 = 'e1b07b7125815e8e712086cb12bc7de54546365d5f407f79629689da855d64a0';
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recalcChecksum(header) {
  header.fill(32, 148, 156);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function mutate(source, target, offset, callback) {
  const bytes = readFileSync(source);
  callback(bytes, offset);
  writeFileSync(target, bytes);
  return digest(bytes);
}

function mutateHeader(bytes, offset, callback) {
  const header = Buffer.from(bytes.subarray(offset, offset + 512));
  callback(header);
  recalcChecksum(header);
  header.copy(bytes, offset);
}

async function rejectsArchive(archive, sha256, pattern, destination) {
  await expect(verifyArchive(archive, sha256, destination)).rejects.toThrow(pattern);
  if (destination) expect(statSync(destination, { throwIfNoEntry: false })).toBeUndefined();
}

it('exact USTAR creation, verification, indexing, and extraction are deterministic', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pages-release-archive-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'assets'), { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>qualified</title>\n');
  writeFileSync(path.join(source, '.nojekyll'), '');
  writeFileSync(path.join(source, 'assets', 'data.txt'), 'stable bytes\n');

  const first = path.join(root, 'first.tar');
  const second = path.join(root, 'second.tar');
  const created = await createArchive(source, first);
  const repeated = await createArchive(source, second);
  expect(created.sha256).toBe(FIXTURE_SHA256);
  expect(repeated.sha256).toBe(FIXTURE_SHA256);
  expect(readFileSync(first)).toEqual(readFileSync(second));

  const handle = await open(first, 'r');
  let inspected;
  try {
    inspected = await inspectArchive(handle, FIXTURE_SHA256);
  } finally {
    await handle.close();
  }
  expect(inspected.entries).toEqual([
    { name: '.nojekyll', size: 0, offset: 512 },
    { name: 'assets/data.txt', size: 13, offset: 1024 },
    { name: 'index.html', size: 40, offset: 2048 },
  ]);
  expect(inspected.totals).toEqual({ files: 3, bytes: 53, htmlBytes: 40 });

  const destination = path.join(root, 'extracted');
  expect(
    await verifyArchive(first, FIXTURE_SHA256, destination),
  ).toEqual({ sha256: FIXTURE_SHA256, files: 3, bytes: 53, htmlBytes: 40 });
  for (const relative of ['.nojekyll', 'assets/data.txt', 'index.html']) {
    expect(readFileSync(path.join(destination, relative))).toEqual(readFileSync(path.join(source, relative)));
  }
  expect(readdirSync(destination).sort()).toEqual(['.nojekyll', 'assets', 'index.html']);

  const firstOffset = inspected.entries[0].offset;
  const secondOffset = inspected.entries[1].offset;
  const secondHeaderOffset = secondOffset - 512;
  const secondSize = inspected.entries[1].size;

  for (const [name, type] of [
    ['symlink', 0x32],
    ['hardlink', 0x31],
    ['pax', 0x78],
    ['gnu-longname', 0x4c],
  ]) {
    const archive = path.join(root, `${name}.tar`);
    const sha256 = mutate(first, archive, firstOffset, (bytes, offset) => {
      mutateHeader(bytes, offset, (header) => { header[156] = type; });
    });
    await rejectsArchive(archive, sha256, /only regular USTAR files are allowed/u, path.join(root, `${name}-dest`));
  }

  for (const [name, hostile] of [
    ['traversal', '../escape'],
    ['absolute', '/absolute'],
    ['backslash', 'a\\b'],
    ['colon', 'C:/drive'],
  ]) {
    const archive = path.join(root, `${name}.tar`);
    const sha256 = mutate(first, archive, firstOffset, (bytes, offset) => {
      mutateHeader(bytes, offset, (header) => {
        header.fill(0, 0, 100);
        header.write(hostile, 0, 100, 'utf8');
      });
    });
    await rejectsArchive(archive, sha256, /unsafe archive path/u);
  }

  const duplicate = path.join(root, 'duplicate.tar');
  const duplicateSha = mutate(first, duplicate, secondHeaderOffset, (bytes, offset) => {
    mutateHeader(bytes, offset, (header) => {
      header.fill(0, 0, 100);
      header.write('.nojekyll', 0, 100, 'utf8');
    });
  });
  await rejectsArchive(duplicate, duplicateSha, /duplicate or conflicting/u);

  const hidden = path.join(root, 'hidden.tar');
  const hiddenSha = mutate(first, hidden, firstOffset, (bytes, offset) => {
    mutateHeader(bytes, offset, (header) => {
      const end = header.indexOf(0, 0);
      header[end + 1] = 0x58;
    });
  });
  await rejectsArchive(hidden, hiddenSha, /hidden header suffix/u);

  const octal = path.join(root, 'octal.tar');
  const octalSha = mutate(first, octal, firstOffset, (bytes, offset) => {
    mutateHeader(bytes, offset, (header) => { header[124] = 0x38; });
  });
  await rejectsArchive(octal, octalSha, /invalid tar number/u);

  const checksum = path.join(root, 'checksum.tar');
  const checksumSha = mutate(first, checksum, firstOffset, (bytes, offset) => {
    bytes[offset + 156] = 0x32;
  });
  await rejectsArchive(checksum, checksumSha, /checksum mismatch/u);

  const truncated = path.join(root, 'truncated.tar');
  writeFileSync(truncated, readFileSync(first).subarray(0, 511));
  await rejectsArchive(truncated, digest(readFileSync(truncated)), /truncated archive/u);

  const padding = path.join(root, 'padding.tar');
  const paddingSha = mutate(first, padding, secondOffset, (bytes, offset) => {
    bytes[offset + secondSize] = 1;
  });
  await rejectsArchive(padding, paddingSha, /nonzero file padding/u);

  const extraZero = path.join(root, 'extra-zero.tar');
  writeFileSync(extraZero, Buffer.concat([readFileSync(first), Buffer.alloc(512)]));
  await rejectsArchive(extraZero, digest(readFileSync(extraZero)), /invalid archive terminator/u);
});
