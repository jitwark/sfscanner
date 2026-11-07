/**
 * The authorized raw-body input the published-secret gate asserts absence about.
 *
 * A sweep's verdict is only as good as the corpus it read: a scan of a
 * substituted, truncated or tampered body directory proves nothing about the
 * corpus the release was generated from. This binds the input **before** any
 * value is extracted from it — a sorted inventory of (name, byte size, SHA-256)
 * over every raw body, hashed into one digest that the owner-provisioned
 * snapshot record must carry — and then requires every body read during
 * extraction to be the exact file that inventory authorized. Absent, unreadable,
 * added, removed or altered input fails closed.
 *
 * The digest is a precondition, never the check itself. A snapshot that matched
 * does not make a corpus safe to sweep; it makes the bytes that *were* swept
 * identifiable, so the strict and loose value sweeps still run and still decide
 * the verdict.
 *
 * Binding is per file and bounded: one read into a buffer, hash that buffer,
 * compare it to the authorized row, parse that same buffer, drop it before the
 * next body. Nothing is re-read and no whole-corpus copy is held, so there is no
 * window in which a body could change between the bytes that were hashed and the
 * bytes that were parsed.
 *
 * Nothing here returns or prints a body byte. The inventory carries names, byte
 * sizes and hashes; a failure names the file, the digest and the counts. Parse
 * errors from the snapshot record are replaced with fixed text, because
 * `JSON.parse` quotes its own input and a mistyped secret must not be echoed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_ALGORITHM = 'sha256';
export const INVENTORY_DIGEST_PREFIX = 'sha256:';
export const INVENTORY_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Which files are raw bodies. The extraction and the inventory share this
 * predicate deliberately: a digest over a different file set than the extractor
 * reads would bind the wrong input.
 */
export const BODY_FILE_NAME = /^official__\d+_.+\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** The error's code only: an fs message carries a path, and nothing here needs it. */
function codeSuffix(error) {
  return typeof error?.code === 'string' ? ` (${error.code})` : '';
}

function rejected(reason, detail, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

/**
 * The bodies, in name order. Byte-wise comparison, not locale collation: the
 * order must not depend on the host's locale or it cannot be reproduced on
 * another runner.
 */
export function bodyFileNames(bodiesDir) {
  return fs.readdirSync(bodiesDir)
    .filter((name) => BODY_FILE_NAME.test(name))
    .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

/** The one digest the release continues on, over the sorted inventory and no other input. */
export function inventoryDigest(entries) {
  const canonical = JSON.stringify(
    [...entries]
      .sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
      .map((entry) => [entry.name, entry.bytes, entry.sha256]),
  );
  return `${INVENTORY_DIGEST_PREFIX}${sha256Hex(canonical)}`;
}

/**
 * Read every body once, in name order. The entry is hashed from the same buffer
 * that is handed to `consume`, and the buffer is dropped before the next read.
 * A file that will not read is reported, not thrown at the caller.
 */
export function readBodies(bodiesDir, consume) {
  const names = bodyFileNames(bodiesDir);
  const entries = [];
  const unreadable = [];
  for (const name of names) {
    let content;
    try {
      content = fs.readFileSync(path.join(bodiesDir, name));
    } catch (error) {
      unreadable.push({ name, code: typeof error?.code === 'string' ? error.code : 'unknown' });
      continue;
    }
    entries.push({ name, bytes: content.length, sha256: sha256Hex(content) });
    consume?.(name, content);
  }
  return { names, entries, unreadable };
}

/** The inventory as a snapshot record's `files` list. A body that will not read is a failure, not a row. */
export function inventoryEntries(bodiesDir) {
  const { entries, unreadable } = readBodies(bodiesDir);
  if (unreadable.length > 0) {
    throw new Error(`cannot inventory ${unreadable.length} unreadable body file(s): ${unreadable.map((entry) => entry.name).join(', ')}`);
  }
  return entries;
}

function invalidField(field) {
  return rejected('snapshot-invalid', `input snapshot is not a verified inventory record: ${field} is missing or invalid`);
}

/**
 * Read and self-check the provisioned snapshot record.
 *
 * Returns `{ok: true, snapshotPath, inventory: {entries, digest, fileCount, totalBytes, ...}}`
 * when the record is a coherent inventory of itself, and `{ok: false, reason, detail}`
 * otherwise. `reason` is `snapshot-missing`, `snapshot-unreadable` or `snapshot-invalid`;
 * the gate fails closed on all three.
 */
export function readInputSnapshot(snapshotPath) {
  if (!snapshotPath) {
    return rejected(
      'snapshot-missing',
      'no verified input snapshot was provisioned (pass --snapshot <file> or set OFFICIAL_BODIES_SNAPSHOT)',
    );
  }
  let text;
  try {
    text = fs.readFileSync(snapshotPath, 'utf8');
  } catch (error) {
    return rejected('snapshot-unreadable', `input snapshot ${snapshotPath} could not be read${codeSuffix(error)}`);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    // Fixed text on purpose: `JSON.parse` quotes the first characters of its
    // input, so a snapshot holding a secret would echo it into retained output.
    return rejected('snapshot-unreadable', `input snapshot ${snapshotPath} is not valid JSON`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return invalidField('the record itself');
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION) return invalidField('schemaVersion');
  if (record.algorithm !== INVENTORY_ALGORITHM) return invalidField('algorithm');
  if (typeof record.inventoryDigest !== 'string' || !INVENTORY_DIGEST.test(record.inventoryDigest)) return invalidField('inventoryDigest');
  if (!Array.isArray(record.files)) return invalidField('files');
  const names = new Set();
  for (const row of record.files) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return invalidField('files[] entries');
    if (typeof row.name !== 'string' || !BODY_FILE_NAME.test(row.name)) return invalidField('files[].name');
    if (names.has(row.name)) return invalidField('files[].name (duplicate row)');
    names.add(row.name);
    if (!Number.isInteger(row.bytes) || row.bytes < 0) return invalidField('files[].bytes');
    if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return invalidField('files[].sha256');
  }

  // Counts are compared below and named on failure, so they are guarded here: an
  // unvalidated field interpolated into a detail line is how a value reaches
  // retained output (the same class as the parse message above).
  if (!Number.isInteger(record.fileCount) || record.fileCount < 0) return invalidField('fileCount');
  if (!Number.isInteger(record.totalBytes) || record.totalBytes < 0) return invalidField('totalBytes');

  const entries = record.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  const digest = inventoryDigest(entries);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (record.inventoryDigest !== digest) {
    return rejected(
      'snapshot-invalid',
      `input snapshot ${snapshotPath} records an inventoryDigest that does not cover its own files list ` +
      `(recorded ${record.inventoryDigest}, the list hashes to ${digest})`,
    );
  }
  if (record.fileCount !== entries.length || record.totalBytes !== totalBytes) {
    return rejected(
      'snapshot-invalid',
      `input snapshot ${snapshotPath} records fileCount/totalBytes that disagree with its own files list ` +
      `(recorded ${record.fileCount} files / ${record.totalBytes} bytes, the list has ${entries.length} files / ${totalBytes} bytes)`,
    );
  }
  return {
    ok: true,
    snapshotPath,
    inventory: {
      entries,
      digest,
      fileCount: entries.length,
      totalBytes,
      algorithm: INVENTORY_ALGORITHM,
      schemaVersion: INVENTORY_SCHEMA_VERSION,
    },
  };
}

/**
 * Stream the bodies once and require every one of them to be the file the
 * verified inventory authorized: same name set, same byte size, same SHA-256.
 * `consume` receives the buffer that was just compared, so what the caller
 * parses is exactly what the digest bound. Fails closed on the first divergence.
 */
export function bindBodiesToInventory({ bodiesDir, inventory, consume }) {
  let names;
  try {
    names = bodyFileNames(bodiesDir);
  } catch (error) {
    return rejected('bodies-unreadable', `raw bodies at ${bodiesDir} could not be listed${codeSuffix(error)}`);
  }
  const expected = new Map(inventory.entries.map((entry) => [entry.name, entry]));
  const missing = inventory.entries.filter((entry) => !names.includes(entry.name)).map((entry) => entry.name);
  const unexpected = names.filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    return rejected(
      'name-set-mismatch',
      `the bodies on disk are not the set the verified inventory authorizes: ${missing.length} missing, ` +
      `${unexpected.length} unexpected`,
      { missing: missing.slice(0, 10), unexpected: unexpected.slice(0, 10) },
    );
  }

  const entries = [];
  for (const name of names) {
    const wanted = expected.get(name);
    let content;
    try {
      content = fs.readFileSync(path.join(bodiesDir, name));
    } catch (error) {
      return rejected('body-unreadable', `authorized body ${name} could not be read${codeSuffix(error)}`);
    }
    const bytes = content.length;
    const sha256 = sha256Hex(content);
    if (bytes !== wanted.bytes || sha256 !== wanted.sha256) {
      return rejected(
        'digest-mismatch',
        `authorized body ${name} does not match the verified inventory (recorded ${wanted.bytes} bytes / ` +
        `${wanted.sha256}, read ${bytes} bytes / ${sha256})`,
      );
    }
    entries.push({ name, bytes, sha256 });
    consume?.(name, content);
  }
  return { ok: true, names, entries, digest: inventoryDigest(entries) };
}
