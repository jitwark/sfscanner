import { open, lstat, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  accounting,
  confinedPath,
  fail,
  isSameOrInside,
  MAX_ARCHIVE_BYTES,
  safeRelative,
  sourceFiles,
} from './pages-release-paths.mjs';

const BLOCK = 512, decoder = new TextDecoder('utf-8', { fatal: true });
async function read(file, size, position) {
  const buffer = Buffer.alloc(size);
  for (let copied = 0; copied < size;) {
    const { bytesRead } = await file.read(buffer, copied, size - copied, position + copied);
    if (bytesRead === 0) fail('truncated archive');
    copied += bytesRead;
  }
  return buffer;
}
function field(buffer, start, length) {
  const raw = buffer.subarray(start, start + length), end = raw.indexOf(0);
  if (end >= 0 && raw.subarray(end).some((byte) => byte !== 0)) fail('hidden header suffix');
  return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
}
function octal(buffer, start, length) {
  const value = buffer.subarray(start, start + length).toString('ascii');
  if (!/^[0-7]+[\0 ]*$/u.test(value)) fail('invalid tar number');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail('unsafe tar number');
  return number;
}
function checksum(header) {
  return header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
}
export function tarHeader(name, size) {
  safeRelative(name);
  let leaf = name, prefix = '';
  if (Buffer.byteLength(leaf) > 100) {
    const split = [...name.matchAll(/\//gu)].map((match) => match.index).reverse()
      .find((index) => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (split === undefined) fail('path exceeds USTAR format');
    prefix = name.slice(0, split); leaf = name.slice(split + 1);
  }
  if (Buffer.byteLength(leaf) > 100 || Buffer.byteLength(prefix) > 155) fail('path exceeds USTAR format');
  const header = Buffer.alloc(BLOCK);
  const put = (value, start) => header.write(value, start, 'utf8');
  const number = (value, start, length) => {
    const encoded = value.toString(8).padStart(length - 1, '0');
    if (encoded.length >= length) fail('file exceeds USTAR format');
    put(`${encoded}\0`, start);
  };
  put(leaf, 0); number(0o644, 100, 8); number(0, 108, 8); number(0, 116, 8);
  number(size, 124, 12); number(0, 136, 12); header.fill(32, 148, 156);
  put('0', 156); put('ustar\0', 257); put('00', 263); put(prefix, 345);
  put(`${checksum(header).toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
  return digest.digest('hex');
}

/** Parse the complete archive before creating any destination or extracting any payload. */
export async function inspectArchive(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) fail('exact lowercase SHA256 is required');
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE_BYTES) fail('unsafe archive file or size');
  if (await hash(file) !== expectedSha256) fail('archive SHA256 mismatch');
  const budget = accounting(), entries = [];
  let offset = 0;
  while (offset < stat.size) {
    const header = await read(file, BLOCK, offset); offset += BLOCK;
    if (header.every((byte) => byte === 0)) {
      const end = await read(file, BLOCK, offset);
      if (end.some((byte) => byte !== 0) || offset + BLOCK !== stat.size) fail('invalid archive terminator');
      return { entries, totals: budget.finish(), sha256: expectedSha256 };
    }
    if (octal(header, 148, 8) !== checksum(header)) fail('tar checksum mismatch');
    if (field(header, 257, 6) !== 'ustar' || field(header, 263, 2) !== '00'
      || header[156] !== 48 || field(header, 157, 100) !== '') fail('only regular USTAR files are allowed');
    const prefix = field(header, 345, 155), name = safeRelative(`${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`);
    const size = octal(header, 124, 12); budget.add(name, size);
    const padding = (BLOCK - size % BLOCK) % BLOCK;
    if (offset + size + padding > stat.size) fail('truncated file body');
    if (padding && (await read(file, padding, offset + size)).some((byte) => byte !== 0)) fail('nonzero file padding');
    entries.push({ name, size, offset }); offset += size + padding;
  }
  fail('missing archive terminator');
}

export async function createArchive(source, archive) {
  const scanned = await sourceFiles(source), output = path.resolve(archive);
  await confinedPath(path.dirname(output));
  if (isSameOrInside(scanned.root, output)) fail('archive must be outside source');
  const target = await open(output, 'wx', 0o600);
  try {
    for (const entry of scanned.files) {
      await confinedPath(entry.absolute);
      const input = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await input.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== entry.size) fail('source changed during archive creation');
        await target.writeFile(tarHeader(entry.name, entry.size));
        let copied = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) { await target.writeFile(chunk); copied += chunk.length; }
        const after = await input.stat();
        if (copied !== entry.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('source changed during archive creation');
        await target.writeFile(Buffer.alloc((BLOCK - entry.size % BLOCK) % BLOCK));
      } finally { await input.close(); }
    }
    await target.writeFile(Buffer.alloc(2 * BLOCK));
  } finally { await target.close(); }
  return verifyArchive(output);
}

/** Creation may calculate identity; delivery must supply its separately qualified expected hash. */
export async function verifyArchive(archive, expectedSha256, destination) {
  const absolute = await confinedPath(archive);
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const expected = expectedSha256 === undefined ? await hash(file) : expectedSha256;
    const verified = await inspectArchive(file, expected);
    if (destination !== undefined) {
      const output = path.resolve(destination); await confinedPath(path.dirname(output));
      try { await lstat(output); fail('destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(output);
      for (const entry of verified.entries) {
        const target = path.join(output, ...entry.name.split('/'));
        await mkdir(path.dirname(target), { recursive: true }); await confinedPath(path.dirname(target));
        const writer = await open(target, 'wx', 0o644);
        try {
          for (let copied = 0; copied < entry.size;) {
            const chunk = await read(file, Math.min(64 * 1024, entry.size - copied), entry.offset + copied);
            await writer.writeFile(chunk); copied += chunk.length;
          }
        } finally { await writer.close(); }
      }
    }
    return { sha256: expected, ...verified.totals };
  } finally { await file.close(); }
}
