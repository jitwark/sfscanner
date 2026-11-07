import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_FILE_NAME,
  INVENTORY_ALGORITHM,
  INVENTORY_SCHEMA_VERSION,
  bindBodiesToInventory,
  bodyFileNames,
  inventoryDigest,
  inventoryEntries,
  readBodies,
  readInputSnapshot,
  sha256Hex,
} from './published-secret-input-inventory.mjs';

/**
 * Every fixture value is synthetic. Two constraints are under test: the input
 * inventory binds the *bytes* of a body without carrying one into a result, a
 * message or a snapshot record; and the bytes that were hashed are the bytes
 * that get parsed, so a body swapped between reads cannot pass as authorized.
 */
const SECRET_VALUE = 'Basic qqbbjjvvww0123456789';
const BODY_ONE = 'official__1_One.json';
const BODY_TWO = 'official__2_Two.json';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-secret-input-inventory-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFile(directory, name, content) {
  fs.writeFileSync(path.join(directory, name), content, 'utf8');
}

function bodiesDirectory(files = {}) {
  const directory = path.join(temporaryDirectory(), 'official');
  fs.mkdirSync(directory, { recursive: true });
  writeFile(directory, BODY_ONE, JSON.stringify({ nodes: [{ name: 'One', value: SECRET_VALUE }] }));
  writeFile(directory, BODY_TWO, JSON.stringify({ nodes: [{ name: 'Two' }] }));
  for (const [name, content] of Object.entries(files)) writeFile(directory, name, content);
  return directory;
}

/** The provisioning owner's snapshot: the inventory rows, plus the digest over them. */
function snapshotRecord(bodiesDir, overrides = {}) {
  const files = inventoryEntries(bodiesDir);
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    algorithm: INVENTORY_ALGORITHM,
    inventoryDigest: inventoryDigest(files),
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    files,
    ...overrides,
  };
}

function snapshotOf(bodiesDir, overrides = {}) {
  const file = path.join(temporaryDirectory(), 'input-snapshot.json');
  writeFile(path.dirname(file), path.basename(file), JSON.stringify(snapshotRecord(bodiesDir, overrides)));
  return file;
}

/** The gate's own two-step path: validate the record, then bind the bodies to it. */
function verify(bodiesDir, snapshotPath) {
  const read = readInputSnapshot(snapshotPath);
  if (!read.ok) return read;
  const bound = bindBodiesToInventory({ bodiesDir, inventory: read.inventory });
  return bound.ok ? { ok: true, snapshotPath: read.snapshotPath, ...read.inventory } : bound;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe('published secret input inventory', () => {
  it('lists only the raw body files, in name order', () => {
    const directory = bodiesDirectory({ 'README.md': '# not a body', 'official__3.json': '{}', 'other__1_Body.json': '{}' });
    expect(BODY_FILE_NAME.test('official__4803_Template.json')).toBe(true);
    expect(BODY_FILE_NAME.test('official__3.json')).toBe(false);
    expect(inventoryEntries(directory).map((entry) => entry.name)).toEqual([BODY_ONE, BODY_TWO]);
    expect(bodyFileNames(directory)).toEqual([BODY_ONE, BODY_TWO]);
  });

  it('binds each body by name, byte size and content hash and nothing else', () => {
    const directory = bodiesDirectory();
    const [entry] = inventoryEntries(directory).filter((candidate) => candidate.name === BODY_ONE);
    expect(Object.keys(entry).sort()).toEqual(['bytes', 'name', 'sha256']);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.bytes).toBe(fs.statSync(path.join(directory, BODY_ONE)).size);
  });

  it('is content-addressed and order-independent, so the same bodies always digest the same', () => {
    const directory = bodiesDirectory();
    const entries = inventoryEntries(directory);
    expect(inventoryDigest([...entries].reverse())).toBe(inventoryDigest(entries));
    expect(inventoryDigest(entries)).toBe(inventoryDigest(inventoryEntries(directory)));
    expect(inventoryDigest(entries)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the digest when a body is rewritten, resized or renamed', () => {
    const original = inventoryDigest(inventoryEntries(bodiesDirectory()));
    expect(inventoryDigest(inventoryEntries(bodiesDirectory({ [BODY_ONE]: JSON.stringify({ nodes: [] }) })))).not.toBe(original);

    const renamed = bodiesDirectory();
    fs.renameSync(path.join(renamed, BODY_TWO), path.join(renamed, 'official__9_Two.json'));
    expect(inventoryDigest(inventoryEntries(renamed))).not.toBe(original);

    const added = bodiesDirectory({ 'official__4_Four.json': '{}' });
    expect(inventoryDigest(inventoryEntries(added))).not.toBe(original);
  });

  it('hashes the same in-process bytes it hands to the consumer, so a swap cannot be laundered through a second read', () => {
    const directory = bodiesDirectory();
    const handed = new Map();
    const entries = inventoryEntries(directory);
    const ledger = readBodies(directory, (name, content) => {
      handed.set(name, content);
      // The swap: the file on disk changes the instant after the bytes were read.
      fs.writeFileSync(path.join(directory, name), `${content.toString('utf8')} `);
    }).entries;

    expect(ledger).toEqual(entries);
    for (const entry of entries) {
      const content = handed.get(entry.name);
      expect(entry.sha256).toBe(sha256Hex(content));
      expect(entry.bytes).toBe(content.length);
      // The bytes that were hashed are no longer the bytes on disk...
      expect(fs.statSync(path.join(directory, entry.name)).size).not.toBe(entry.bytes);
    }

    // ...so any *later* read of that path sees the swapped bytes. The binding does
    // read the disk — that is how it streams — and that is exactly why it compares
    // per file and hands the compared buffer to the parser: a second read can only
    // ever fail closed here, never be accepted as the authorized row.
    const snapshotPath = snapshotOf(directory, { files: entries, inventoryDigest: inventoryDigest(entries), fileCount: entries.length, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) });
    const bound = bindBodiesToInventory({ bodiesDir: directory, inventory: readInputSnapshot(snapshotPath).inventory });
    expect(bound.ok).toBe(false);
    expect(bound.reason).toBe('digest-mismatch');
  });

  it('reports an unreadable body instead of throwing a stack trace through the caller', () => {
    const directory = bodiesDirectory();
    fs.mkdirSync(path.join(directory, 'official__7_Directory.json'));
    const { entries, unreadable } = readBodies(directory);
    expect(entries.map((entry) => entry.name)).toEqual([BODY_ONE, BODY_TWO]);
    expect(unreadable).toEqual([{ name: 'official__7_Directory.json', code: 'EISDIR' }]);
    expect(() => inventoryEntries(directory)).toThrow(/unreadable body file/);
  });
});

describe('published secret input snapshot verification', () => {
  it('accepts a snapshot that binds exactly the bodies on disk', () => {
    const directory = bodiesDirectory();
    const verdict = verify(directory, snapshotOf(directory));
    expect(verdict).toMatchObject({
      ok: true,
      digest: inventoryDigest(inventoryEntries(directory)),
      fileCount: 2,
      algorithm: INVENTORY_ALGORITHM,
      schemaVersion: INVENTORY_SCHEMA_VERSION,
    });
    expect(verdict.entries).toHaveLength(2);
  });

  it('fails closed when no snapshot was provisioned at all', () => {
    const verdict = readInputSnapshot(undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('snapshot-missing');
    expect(verdict.detail).toContain('OFFICIAL_BODIES_SNAPSHOT');
  });

  it('fails closed when the snapshot file is absent', () => {
    const verdict = readInputSnapshot(path.join(temporaryDirectory(), 'absent.json'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('snapshot-unreadable');
  });

  it('fails closed when the snapshot is not JSON at all, without echoing what it held', () => {
    const file = path.join(temporaryDirectory(), 'snapshot.json');
    writeFile(path.dirname(file), path.basename(file), SECRET_VALUE);
    const verdict = readInputSnapshot(file);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('snapshot-unreadable');
    // `JSON.parse`'s own message quotes the first characters of its input, which
    // is how a mistyped secret could reach retained output through this path.
    expect(verdict.detail).not.toContain(SECRET_VALUE);
    expect(verdict.detail).not.toContain(SECRET_VALUE.slice(0, 10));
    expect(verdict.detail).not.toContain('Unexpected token');
  });

  it('fails closed when the snapshot is not a record this gate understands', () => {
    const directory = bodiesDirectory();
    const record = snapshotRecord(directory);
    const cases = [
      '[]',
      'null',
      '"a string"',
      JSON.stringify({ ...record, schemaVersion: 99 }),
      JSON.stringify({ ...record, algorithm: 'md5' }),
      JSON.stringify({ ...record, inventoryDigest: 'sha256:nothex' }),
      JSON.stringify({ ...record, inventoryDigest: SECRET_VALUE }),
      JSON.stringify({ ...record, inventoryDigest: `sha256:${'0'.repeat(64)}` }),
      JSON.stringify({ ...record, fileCount: 99 }),
      JSON.stringify({ ...record, totalBytes: record.totalBytes + 1 }),
      JSON.stringify({ ...record, files: undefined }),
      JSON.stringify({ ...record, files: [{ ...record.files[0], name: '../escape.json' }] }),
      JSON.stringify({ ...record, files: [{ ...record.files[0], bytes: -1 }] }),
      JSON.stringify({ ...record, files: [{ ...record.files[0], sha256: 'nothex' }] }),
      JSON.stringify({ ...record, files: [record.files[0], record.files[0]] }),
      JSON.stringify({ ...record, files: [42] }),
    ];
    for (const raw of cases) {
      const file = path.join(temporaryDirectory(), 'snapshot.json');
      writeFile(path.dirname(file), path.basename(file), raw);
      const verdict = readInputSnapshot(file);
      expect(verdict.ok, raw).toBe(false);
      expect(verdict.reason, raw).toBe('snapshot-invalid');
      expect(verdict.detail, raw).not.toContain(SECRET_VALUE);
    }
  });

  it('names an invalid count field instead of echoing it, for every field the survive path interpolates', () => {
    const directory = bodiesDirectory();
    const record = snapshotRecord(directory);
    const cases = [
      ['fileCount', { fileCount: SECRET_VALUE }],
      ['totalBytes', { totalBytes: SECRET_VALUE }],
      ['fileCount', { fileCount: ` ${SECRET_VALUE} ` }],
      ['totalBytes', { totalBytes: -1 }],
      ['fileCount', { fileCount: 2.5 }],
      ['totalBytes', { totalBytes: null }],
      ['totalBytes', { totalBytes: undefined }],
      ['fileCount', { fileCount: [2] }],
    ];
    for (const [field, override] of cases) {
      const file = path.join(temporaryDirectory(), 'snapshot.json');
      writeFile(path.dirname(file), path.basename(file), JSON.stringify({ ...record, ...override }));
      const verdict = readInputSnapshot(file);
      expect(verdict.ok, JSON.stringify(override)).toBe(false);
      expect(verdict.reason, JSON.stringify(override)).toBe('snapshot-invalid');
      // Named, never echoed: the field would otherwise be interpolated verbatim into
      // stderr and into retained gate logs, which is the parse-message class again.
      expect(verdict.detail, JSON.stringify(override)).toBe(`input snapshot is not a verified inventory record: ${field} is missing or invalid`);
      expect(verdict.detail, JSON.stringify(override)).not.toContain(SECRET_VALUE);
      expect(verdict.detail, JSON.stringify(override)).not.toContain(SECRET_VALUE.slice(0, 10));
    }
  });

  it('fails closed when a body on disk is not the one the verified inventory authorized', () => {
    const authorized = bodiesDirectory();
    const snapshotPath = snapshotOf(authorized);
    const substituted = bodiesDirectory({ [BODY_TWO]: JSON.stringify({ nodes: [{ name: 'substituted' }] }) });
    const verdict = verify(substituted, snapshotPath);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('digest-mismatch');
    expect(verdict.detail).toContain(BODY_TWO);
    expect(verdict.detail).not.toContain(SECRET_VALUE);
  });

  it('fails closed when a body is added or removed after the snapshot was taken', () => {
    const directory = bodiesDirectory();
    const snapshotPath = snapshotOf(directory);
    fs.writeFileSync(path.join(directory, 'official__5_Five.json'), '{}', 'utf8');
    const added = verify(directory, snapshotPath);
    expect(added).toMatchObject({ ok: false, reason: 'name-set-mismatch' });
    expect(added.detail).toContain('1 unexpected');

    const other = bodiesDirectory();
    const otherSnapshot = snapshotOf(other);
    fs.rmSync(path.join(other, BODY_ONE));
    const removed = verify(other, otherSnapshot);
    expect(removed).toMatchObject({ ok: false, reason: 'name-set-mismatch' });
    expect(removed.detail).toContain('1 missing');
  });

  it('fails closed when an authorized body cannot be read, naming it without a stack', () => {
    const directory = bodiesDirectory();
    const snapshotPath = snapshotOf(directory);
    fs.rmSync(path.join(directory, BODY_TWO));
    fs.mkdirSync(path.join(directory, BODY_TWO));
    const verdict = verify(directory, snapshotPath);
    expect(verdict).toMatchObject({ ok: false, reason: 'body-unreadable' });
    expect(verdict.detail).toContain(BODY_TWO);
    expect(verdict.detail).not.toMatch(/\n\s+at /);
  });

  it('never carries a body value into a verdict or into an accepted identity', () => {
    const directory = bodiesDirectory();
    const accepted = verify(directory, snapshotOf(directory));
    const rejected = verify(directory, snapshotOf(directory, { inventoryDigest: `sha256:${'0'.repeat(64)}` }));
    expect(Object.keys(accepted).sort()).toEqual(['algorithm', 'digest', 'entries', 'fileCount', 'ok', 'schemaVersion', 'snapshotPath', 'totalBytes']);
    for (const verdict of [accepted, rejected]) {
      expect(JSON.stringify(verdict)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(verdict)).not.toContain(Buffer.from(SECRET_VALUE, 'utf8').toString('base64'));
    }
  });
});
