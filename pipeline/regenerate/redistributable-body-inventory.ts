import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';

/**
 * One redistributable sanitized body, addressed the way the catalogue points at
 * it. A body is not its own file: the packager writes one workflow per JSONL
 * line, so `path` plus `line` identifies the exact record and `bytes` and
 * `sha256` describe exactly those bytes.
 */
export type BodyInventoryRow = {
  /** Pack path relative to the corpus root, e.g. `packs/pack-0.jsonl` — the same convention `app/src/catalogue/download.ts` uses. */
  path: string;
  line: number;
  /**
   * Size of the hashed record: the packed `JSON.stringify(workflow)` bytes,
   * excluding the record's one JSONL LF (AUDIT-DL-001). One byte less than the
   * catalogue's `download.length`, which spans the newline.
   */
  bytes: number;
  sha256: string;
};

export type RedistributableBodyInventory = {
  count: number;
  totalBytes: number;
  rows: BodyInventoryRow[];
};

/**
 * Build the sorted inventory of redistributable sanitized bodies from the packs
 * themselves.
 *
 * The bytes are read back out of the pack files rather than trusted from the
 * catalogue: each body's SHA-256 is recomputed from the record and asserted
 * against `download.sha256` when the catalogue publishes one, so a divergence
 * between the catalogue and the pack is a hard failure here instead of a
 * silently republished inventory. Reconciliation is structural — pack and line
 * must exist and the byte range must be the record plus its newline — not a
 * hard-coded total, so the count reflects whatever the corpus actually holds.
 */
export function buildRedistributableBodyInventory(
  entries: readonly Entry[],
  dataDir: string,
): RedistributableBodyInventory {
  const packLines = new Map<number, string[]>();
  const rowsByPack = new Map<number, BodyInventoryRow[]>();
  let totalBytes = 0;

  for (const entry of entries) {
    const download = entry.download;
    if (entry.rights?.status !== 'redistributable' || download === undefined) continue;
    let lines = packLines.get(download.pack);
    if (lines === undefined) {
      const packFile = path.join(dataDir, 'packs', `pack-${download.pack}.jsonl`);
      try {
        lines = fs.readFileSync(packFile, 'utf8').split('\n');
      } catch {
        throw new Error(`Redistributable body inventory: pack ${download.pack} could not be read for entry "${entry.id}"`);
      }
      packLines.set(download.pack, lines);
    }
    const record = lines[download.line];
    if (record === undefined) {
      throw new Error(`Redistributable body inventory: pack ${download.pack} has no line ${download.line} for entry "${entry.id}"`);
    }
    const bytes = Buffer.byteLength(record, 'utf8');
    if (bytes !== download.length - 1) {
      throw new Error(`Redistributable body inventory: entry "${entry.id}" record is ${bytes} bytes but its catalogue range is ${download.length}`);
    }
    const sha256 = crypto.createHash('sha256').update(record, 'utf8').digest('hex');
    if (download.sha256 !== undefined && download.sha256 !== sha256) {
      throw new Error(`Redistributable body inventory: body SHA-256 mismatch for entry "${entry.id}" (catalogue says ${download.sha256}, pack bytes hash to ${sha256})`);
    }
    const rows = rowsByPack.get(download.pack);
    const row = { path: `packs/pack-${download.pack}.jsonl`, line: download.line, bytes, sha256 };
    if (rows === undefined) rowsByPack.set(download.pack, [row]);
    else rows.push(row);
    totalBytes += bytes;
  }

  const rows: BodyInventoryRow[] = [];
  for (const pack of [...rowsByPack.keys()].sort((a, b) => a - b)) {
    rows.push(...rowsByPack.get(pack)!.sort((a, b) => a.line - b.line));
  }
  return { count: rows.length, totalBytes, rows };
}
