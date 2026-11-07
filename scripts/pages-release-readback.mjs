import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  accounting,
  confinedPath,
  fail,
  isSameOrInside,
  safeRelative,
  sourceFiles,
} from './pages-release-paths.mjs';
import { createReadbackTransfer, verifyPublicFile } from './pages-release-readback-transfer.mjs';

export const READBACK_SCHEMA_VERSION = 'pages-release-readback-v1';
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
  return digest.digest('hex');
}

async function readManifestFile(file) {
  const absolute = await confinedPath(file);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MANIFEST_BYTES) fail('unsafe readback manifest');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('readback manifest is not valid JSON');
    throw error;
  } finally {
    await handle.close();
  }
}

export async function readReadbackManifest(file, expectedArchiveSha256) {
  if (!DIGEST.test(expectedArchiveSha256 ?? '')) fail('exact lowercase SHA256 is required');
  const value = await readManifestFile(file);
  if (value?.schemaVersion !== READBACK_SCHEMA_VERSION || value.archiveSha256 !== expectedArchiveSha256
    || !Array.isArray(value.files) || typeof value.totals !== 'object') fail('readback manifest archive identity mismatch');
  const budget = accounting(), files = [];
  for (const entry of value.files) {
    if (typeof entry?.path !== 'string' || !DIGEST.test(entry.sha256 ?? '')
      || !Number.isSafeInteger(entry.size) || entry.size < 0) fail('invalid readback manifest entry');
    const relative = safeRelative(entry.path);
    budget.add(relative, entry.size);
    files.push({ path: relative, size: entry.size, sha256: entry.sha256 });
  }
  const totals = budget.finish();
  if (value.totals.files !== totals.files || value.totals.bytes !== totals.bytes
    || value.totals.htmlBytes !== totals.htmlBytes) fail('readback manifest totals mismatch');
  return { ...value, files };
}

export async function writeReadbackManifest(source, output, archiveSha256) {
  if (!DIGEST.test(archiveSha256 ?? '')) fail('exact lowercase SHA256 is required');
  const scanned = await sourceFiles(source), files = [];
  for (const entry of scanned.files) {
    const handle = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size) fail('source changed during readback manifest creation');
      files.push({ path: entry.name, size: entry.size, sha256: await hashFile(handle) });
    } finally {
      await handle.close();
    }
  }
  const value = {
    schemaVersion: READBACK_SCHEMA_VERSION,
    archiveSha256,
    totals: scanned.totals,
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const target = path.resolve(output);
  if (isSameOrInside(scanned.root, target)) fail('readback manifest must be outside source');
  await confinedPath(path.dirname(target));
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { path: target, sha256: createHash('sha256').update(bytes).digest('hex'), ...scanned.totals };
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`invalid ${label}`);
  return value;
}

export async function verifyAnonymousReadback({
  pageUrl,
  manifest,
  fetchImpl = fetch,
  concurrency = 6,
  maxRedirects = 3,
  maxAttempts = 3,
  perRequestTimeoutMs = 20_000,
  totalTimeoutMs = 30 * 60_000,
  maxTransferBytes,
  retryDelay = async (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** (attempt - 1)))),
}) {
  positiveInteger(concurrency, 'concurrency', 32);
  positiveInteger(maxAttempts, 'attempt count', 5);
  positiveInteger(perRequestTimeoutMs, 'request timeout', 60_000);
  positiveInteger(totalTimeoutMs, 'readback timeout', 60 * 60_000);
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) fail('invalid redirect limit');
  const base = new URL(pageUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) fail('invalid public Pages URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const deadline = Date.now() + totalTimeoutMs;
  const transfer = createReadbackTransfer({
    manifestBytes: manifest.totals.bytes, maxAttempts, maxTransferBytes,
  });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
    while (cursor < manifest.files.length) {
      if (Date.now() >= deadline) fail('anonymous readback timeout');
      const entry = manifest.files[cursor++];
      await verifyPublicFile({ entry, base, transfer, deadline, options: {
        fetchImpl, maxRedirects, maxAttempts, perRequestTimeoutMs, retryDelay,
      } });
    }
  });
  await Promise.all(workers);
  return {
    schemaVersion: READBACK_SCHEMA_VERSION,
    archiveSha256: manifest.archiveSha256,
    pageUrl: base.href,
    files: manifest.totals.files,
    bytes: manifest.totals.bytes,
    htmlBytes: manifest.totals.htmlBytes,
    transferredBytes: transfer.used,
  };
}
