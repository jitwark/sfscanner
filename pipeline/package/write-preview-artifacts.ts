import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EntryWithChart } from '@hub/contracts';
import { renderStaticSvgPreview } from '../derive/svg-preview.js';
import type { WrittenArtifactInfo } from './write-index-artifacts.js';

/**
 * Byte-addressed sibling artifacts for the P5.6 static SVG preview, structured
 * identically to `write-detail-artifacts.ts`'s `detail-{s}.jsonl`/
 * `detail-index-{s}.json` pair on purpose: the client already knows how to
 * resolve an entry id to a shard via the manifest's `catalogueShards` map and
 * range-fetch a line out of a per-shard JSONL file, so a preview needs no new
 * per-entry field on `Entry` (no `previewRef`) — it reuses that exact lookup.
 *
 * Takes `EntryWithChart[]`, not `Entry[]`: a preview is rendered from the
 * chart, which is never part of the entry's own detail payload.
 */
export function writePreviewArtifacts(
  entriesWithCharts: EntryWithChart[],
  outputDir: string,
  shardSize: number,
): WrittenArtifactInfo[] {
  if (!Number.isInteger(shardSize) || shardSize <= 0) {
    throw new Error(`writePreviewArtifacts requires a positive integer shardSize, got ${shardSize}`);
  }
  if (entriesWithCharts.length === 0) return [];

  const previewsDir = path.join(outputDir, 'previews');
  fs.mkdirSync(previewsDir, { recursive: true });

  const written: WrittenArtifactInfo[] = [];
  const shardCount = Math.ceil(entriesWithCharts.length / shardSize);

  for (let s = 0; s < shardCount; s++) {
    const startIdx = s * shardSize;
    const endIdx = Math.min(startIdx + shardSize, entriesWithCharts.length);
    const shardItems = entriesWithCharts.slice(startIdx, endIdx);

    const index: Record<string, { offset: number; length: number; sha256: string }> = {};
    let offset = 0;
    let jsonl = '';

    for (const item of shardItems) {
      const preview = renderStaticSvgPreview(item.chart);
      const nodeTypes = [...new Set(preview.nodeList.map((node) => node.type))].sort();
      const nodeTypeIndexes = new Map(nodeTypes.map((type, index) => [type, index]));
      // schemaVersion/tier/hash travel with the record itself, not the index,
      // so a reader that already fetched the bytes never needs a second round
      // trip to learn what it is holding.
      const line = JSON.stringify({
        id: item.entry.id,
        schemaVersion: preview.schemaVersion,
        tier: preview.tier,
        svg: preview.svg,
        // Tuples and a deterministic type table keep the public shard compact
        // while the shared parser exposes named objects to callers.
        nodeTypes,
        nodeList: preview.nodeList.map((node) => [node.name, nodeTypeIndexes.get(node.type), ['trigger', 'transform', 'ai', 'http', 'code', 'storage', 'flow', 'other'].indexOf(node.category)]),
        contentHash: preview.contentHash,
        unresolvedEdgeCount: preview.unresolvedEdgeCount,
      });
      const lineBytes = Buffer.from(line, 'utf8');

      index[item.entry.id] = {
        offset,
        length: lineBytes.byteLength,
        sha256: crypto.createHash('sha256').update(lineBytes).digest('hex'),
      };
      offset += lineBytes.byteLength + 1;
      jsonl += `${line}\n`;
    }

    const jsonlRelPath = `previews/preview-${s}.jsonl`;
    fs.writeFileSync(path.join(outputDir, jsonlRelPath), jsonl, 'utf8');
    written.push({
      relativePath: jsonlRelPath,
      absolutePath: path.join(outputDir, jsonlRelPath),
      entryCount: shardItems.length,
      entryRange: [startIdx, endIdx - 1],
      encoding: 'identity',
    });

    const indexRelPath = `previews/preview-index-${s}.json`;
    fs.writeFileSync(path.join(outputDir, indexRelPath), JSON.stringify(index), 'utf8');
    written.push({
      relativePath: indexRelPath,
      absolutePath: path.join(outputDir, indexRelPath),
      entryCount: shardItems.length,
      entryRange: [startIdx, endIdx - 1],
      encoding: 'identity',
    });
  }

  return written;
}
