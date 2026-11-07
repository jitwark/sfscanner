import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { parseEntryArtifact } from '@hub/contracts/entry-artifact';
import type { WrittenArtifactInfo } from './write-index-artifacts.js';

/**
 * Byte-addressed sibling artifacts for whole-shard catalogue reads (P1.7).
 *
 * `detail-{s}.jsonl` holds one compact entry per line; `detail-index-{s}.json`
 * maps an entry ID to that line's offset/length/sha256 so the browser can range
 * -fetch a few KB instead of the 12–35 MB `catalogue-{s}.json` array. Shard
 * boundaries here MUST match `write-artifacts.ts`'s catalogue-shard loop
 * (same input order, same `shardSize`) — the client resolves an ID to a shard
 * via the manifest's existing `catalogueShards` map, then asks this shard's
 * index for the offset. A mismatch would point a range request at the wrong
 * shard's bytes. Takes `Entry[]`, not `EntryWithChart[]` — a chart is never
 * part of the entry's own detail payload — which also lets a backfill re-derive
 * these from the already-packaged `catalogue-N.json` shards alone.
 */
export function writeDetailArtifacts(
  entries: Entry[],
  outputDir: string,
  shardSize: number,
): WrittenArtifactInfo[] {
  if (!Number.isInteger(shardSize) || shardSize <= 0) {
    throw new Error(`writeDetailArtifacts requires a positive integer shardSize, got ${shardSize}`);
  }
  if (entries.length === 0) return [];

  const detailsDir = path.join(outputDir, 'details');
  fs.mkdirSync(detailsDir, { recursive: true });

  const written: WrittenArtifactInfo[] = [];
  const shardCount = Math.ceil(entries.length / shardSize);

  for (let s = 0; s < shardCount; s++) {
    const startIdx = s * shardSize;
    const endIdx = Math.min(startIdx + shardSize, entries.length);
    const shardEntries = entries.slice(startIdx, endIdx);

    const index: Record<string, { offset: number; length: number; sha256: string }> = {};
    let offset = 0;
    let jsonl = '';

    for (const entry of shardEntries) {
      const line = JSON.stringify(parseEntryArtifact(entry));
      const lineBytes = Buffer.from(line, 'utf8');
      // The index's `length` excludes the trailing newline below, so a range
      // fetch pulls back exactly the JSON bytes the hash was computed over —
      // no trim/split needed on read. The newline itself exists only so
      // generic per-line tooling (restamp-manifest.mjs's entry-count
      // heuristic, `wc -l`) reads this file the same way it reads
      // chart-N.jsonl/pack-N.jsonl.
      index[entry.id] = {
        offset,
        length: lineBytes.byteLength,
        sha256: crypto.createHash('sha256').update(lineBytes).digest('hex'),
      };
      offset += lineBytes.byteLength + 1;
      jsonl += `${line}\n`;
    }

    const jsonlRelPath = `details/detail-${s}.jsonl`;
    fs.writeFileSync(path.join(outputDir, jsonlRelPath), jsonl, 'utf8');
    written.push({
      relativePath: jsonlRelPath,
      absolutePath: path.join(outputDir, jsonlRelPath),
      entryCount: shardEntries.length,
      entryRange: [startIdx, endIdx - 1],
      encoding: 'identity',
    });

    const indexRelPath = `details/detail-index-${s}.json`;
    fs.writeFileSync(path.join(outputDir, indexRelPath), JSON.stringify(index), 'utf8');
    written.push({
      relativePath: indexRelPath,
      absolutePath: path.join(outputDir, indexRelPath),
      entryCount: shardEntries.length,
      entryRange: [startIdx, endIdx - 1],
      encoding: 'identity',
    });
  }

  return written;
}
