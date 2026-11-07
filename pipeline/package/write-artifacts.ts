import crypto from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path';
import type { Entry, EntryWithChart, LIMITS } from '@hub/contracts';
import { parseEntryArtifact } from '@hub/contracts/entry-artifact';
import type { BuildSearchIndexResult } from '../index/build-search-index.js';
import type { FacetData } from '../index/facets.js';
import { writeIndexArtifacts, type WrittenArtifactInfo } from './write-index-artifacts.js';
import { writeDetailArtifacts } from './write-detail-artifacts.js'; import { writePreviewArtifacts } from './write-preview-artifacts.js';
import { prepareCatalogueClaims } from './quarantine.js';
import { clearOwnedArtifacts } from './artifact-cleanup.js';
export const SHARD_SIZE = 2_000;
const PACK_SIZE = 250;
/** Canonical packed-record bytes are UTF-8 of exact JSON.stringify output, excluding the one JSONL LF. */
function packedRecordJson(workflow: unknown): string { return JSON.stringify(workflow); }
export type { WrittenArtifactInfo } from './write-index-artifacts.js';
export function writeArtifacts(
  entriesWithCharts: EntryWithChart[],
  workflowsById: Map<string, unknown>,
  searchIndexResult: BuildSearchIndexResult,
  facetsData: FacetData,
  outputDir: string,
  options: { legacyV1?: boolean } = {},
): WrittenArtifactInfo[] {
  fs.mkdirSync(outputDir, { recursive: true });
  clearOwnedArtifacts(outputDir);
  const writtenArtifacts: WrittenArtifactInfo[] = [];
  const claimPartition = prepareCatalogueClaims(entriesWithCharts, outputDir, { search: searchIndexResult, facets: facetsData });
  entriesWithCharts = claimPartition.published;
  searchIndexResult = claimPartition.search;
  facetsData = claimPartition.facets;
  if (claimPartition.report) writtenArtifacts.push(claimPartition.report);
  fs.mkdirSync(path.join(outputDir, 'charts'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'packs'), { recursive: true });
  const missingWorkflows = entriesWithCharts
    .filter(
      (item) =>
        item.entry.rights?.status === 'redistributable' &&
        item.entry.dedup?.canonical === true &&
        workflowsById.get(item.entry.id) === undefined,
    )
    .map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      source: item.entry.source,
    }));
  if (missingWorkflows.length > 0) {
    const reportRelPath = 'missing-workflows.json';
    const reportAbsPath = path.join(outputDir, reportRelPath);
    fs.writeFileSync(reportAbsPath, JSON.stringify(missingWorkflows, null, 2), 'utf8');

    const firstIds = missingWorkflows
      .slice(0, 5)
      .map((workflow) => workflow.id)
      .join(', ');
    const noun = missingWorkflows.length === 1 ? 'entry' : 'entries';
    throw new Error(
      `Missing workflow JSON for ${missingWorkflows.length} redistributable canonical ${noun}: ${firstIds}`,
    );
  }
  const totalEntries = entriesWithCharts.length;
  const redistributableItems = entriesWithCharts.filter(
    (item) =>
      item.entry.rights?.status === 'redistributable' && item.entry.dedup?.canonical === true,
  );

  for (const item of entriesWithCharts) {
    if (item.entry.rights?.status !== 'redistributable' || item.entry.dedup?.canonical !== true) {
      delete item.entry.download;
    }
  }

  const packCount = Math.ceil(redistributableItems.length / PACK_SIZE);
  for (let p = 0; p < packCount; p++) {
    const startIdx = p * PACK_SIZE;
    const packItems = redistributableItems.slice(startIdx, Math.min(startIdx + PACK_SIZE, redistributableItems.length));
    let packOffset = 0;

    for (let l = 0; l < packItems.length; l++) {
      const item = packItems[l]!;
      const recordJson = packedRecordJson(workflowsById.get(item.entry.id));
      const lineLen = Buffer.byteLength(recordJson + '\n', 'utf8');
      const sha256 = crypto.createHash('sha256').update(recordJson, 'utf8').digest('hex'); // AUDIT-DL-001: excludes the trailing newline, matching the verifier
      item.entry.download = { pack: p, line: l, offset: packOffset, length: lineLen, sha256 };
      packOffset += lineLen;
    }
  }

  const shardCount = Math.ceil(totalEntries / SHARD_SIZE) || 1;
  for (let s = 0; s < shardCount; s++) {
    const startIdx = s * SHARD_SIZE;
    const endIdx = Math.min(startIdx + SHARD_SIZE, totalEntries);
    const shardItems = entriesWithCharts.slice(startIdx, endIdx);

    const chartRelPath = `charts/chart-${s}.jsonl`;
    const chartAbsPath = path.join(outputDir, chartRelPath);
    const chartOffsets: number[] = [];
    const chartLengths: number[] = [];
    let chartOffset = 0;
    let chartLines = '';

    for (let i = 0; i < shardItems.length; i++) {
      const item = shardItems[i]!;
      const lineStr = JSON.stringify(item.chart) + '\n';
      const lineLen = Buffer.byteLength(lineStr, 'utf8');

      item.entry.chartRef = { shard: s, offset: chartOffset, length: lineLen };
      chartOffsets.push(chartOffset);
      chartLengths.push(lineLen);
      chartOffset += lineLen;
      chartLines += lineStr;
    }

    fs.writeFileSync(chartAbsPath, chartLines, 'utf8');
    writtenArtifacts.push({
      relativePath: chartRelPath,
      absolutePath: chartAbsPath,
      entryCount: shardItems.length,
      entryRange: shardItems.length > 0 ? [startIdx, endIdx - 1] : [0, 0],
      offsets: chartOffsets,
      lengths: chartLengths,
    });

    const shardEntries = shardItems.map((item) => parseEntryArtifact(item.entry));
    const catRelPath = `catalogue-${s}.json`;
    const catAbsPath = path.join(outputDir, catRelPath);
    fs.writeFileSync(catAbsPath, JSON.stringify(shardEntries, null, 2), 'utf8');
    writtenArtifacts.push({
      relativePath: catRelPath,
      absolutePath: catAbsPath,
      entryCount: shardEntries.length,
      entryRange: shardEntries.length > 0 ? [startIdx, endIdx - 1] : [0, 0],
    });
  }

  // Byte-addressed siblings of the catalogue-N.json shards above (P1.7 details,
  // P5.6 previews), for bounded reads of one entry. Same input order/shard
  // size as the loop above, so shard numbers agree with `catalogueShards`.
  const entries: Entry[] = entriesWithCharts.map((item) => parseEntryArtifact(item.entry));
  writtenArtifacts.push(...writeDetailArtifacts(entries, outputDir, SHARD_SIZE));
  writtenArtifacts.push(...writePreviewArtifacts(entriesWithCharts, outputDir, SHARD_SIZE));

  const redistributableCount = entries.filter(
    (entry) => entry.rights?.status === 'redistributable',
  ).length;
  for (let p = 0; p < packCount; p++) {
    const startIdx = p * PACK_SIZE;
    const endIdx = Math.min(startIdx + PACK_SIZE, redistributableItems.length);
    const packItems = redistributableItems.slice(startIdx, endIdx);

    const packRelPath = `packs/pack-${p}.jsonl`;
    const packAbsPath = path.join(outputDir, packRelPath);
    const packOffsets: number[] = [];
    const packLengths: number[] = [];
    let packOffset = 0;
    let packLines = '';

    for (let l = 0; l < packItems.length; l++) {
      const item = packItems[l]!;
      const wfJson = workflowsById.get(item.entry.id);
      const lineStr = packedRecordJson(wfJson) + '\n';
      const lineLen = Buffer.byteLength(lineStr, 'utf8');

      packOffsets.push(packOffset);
      packLengths.push(lineLen);
      packOffset += lineLen;
      packLines += lineStr;
    }

    fs.writeFileSync(packAbsPath, packLines, 'utf8');
    writtenArtifacts.push({
      relativePath: packRelPath,
      absolutePath: packAbsPath,
      entryCount: packItems.length,
      entryRange: [startIdx, endIdx - 1],
      offsets: packOffsets,
      lengths: packLengths,
    });
  }

  writtenArtifacts.push(
    ...writeIndexArtifacts(entries, searchIndexResult, facetsData, outputDir, {
      totalEntries,
      redistributableCount,
      shardCount,
      packCount,
    }, options),
  );

  return writtenArtifacts;
}
