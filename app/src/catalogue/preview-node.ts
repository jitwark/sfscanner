import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSvgPreviewArtifact, type Entry, type SvgPreviewArtifact } from '@hub/contracts';
import { readManifestSync } from './manifest-node';

type PreviewIndexEntry = { offset: number; length: number; sha256: string };

let cachedDataDir: string | null | undefined;
let cachedCatalogueShards: Record<string, number> | null = null;

function findDataDir(): string | null {
  if (cachedDataDir !== undefined) return cachedDataDir;
  const candidates = [
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), '..', 'data'),
    path.join(process.cwd(), 'public', 'data'),
    path.join(process.cwd(), 'app', 'public', 'data'),
  ];
  cachedDataDir = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  return cachedDataDir;
}

function readBytesAt(filePath: string, offset: number, length: number): Buffer | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const read = fs.readSync(fd, bytes, 0, length, offset);
    return read === length ? bytes : null;
  } finally {
    fs.closeSync(fd);
  }
}

function validRef(value: unknown): value is PreviewIndexEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Partial<PreviewIndexEntry>;
  return Number.isSafeInteger(ref.offset) && (ref.offset as number) >= 0
    && Number.isSafeInteger(ref.length) && (ref.length as number) > 0 && (ref.length as number) <= 512_000
    && typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256);
}

/** Reads one static preview during the static export without loading a shard. */
export function readPreviewSync(entry: Entry): SvgPreviewArtifact | null {
  const dataDir = findDataDir();
  if (!dataDir) return null;
  cachedCatalogueShards ??= readManifestSync().catalogueShards;
  const shard = cachedCatalogueShards[entry.id];
  if (!Number.isSafeInteger(shard) || (shard as number) < 0) return null;
  const indexPath = path.join(dataDir, 'previews', `preview-index-${shard}.json`);
  const shardPath = path.join(dataDir, 'previews', `preview-${shard}.jsonl`);
  if (!fs.existsSync(indexPath) || !fs.existsSync(shardPath)) return null;

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    const ref = index[entry.id];
    if (!validRef(ref)) return null;
    const bytes = readBytesAt(shardPath, ref.offset, ref.length);
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return null;
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (raw.id !== entry.id) return null;
    const preview = parseSvgPreviewArtifact(raw);
    if (!preview) return null;
    const svgHash = crypto.createHash('sha256').update(preview.svg, 'utf8').digest('hex');
    return svgHash === preview.contentHash ? preview : null;
  } catch {
    return null;
  }
}
