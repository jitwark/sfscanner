import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import type { V2RescanRecord } from './v2-corpus-adapter.js';
import { makeV2RescanManifest } from './v2-rescan-manifest.js';
import { diffV2ResultRecords, type V2ResultDiff } from './v2-result-diff.js';

export const V2_RELEASE_REPORT_SCHEMA_VERSION = 'v2-release-report' as const;

export type V2ReleaseReportCounts = Readonly<{
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  findingChanges: number;
  gradeChanges: number;
  analysisStatusChanges: number;
  authorityChanges: number;
  rightsChanges: number;
}>;

export type V2ReleaseReport = Readonly<{
  schemaVersion: typeof V2_RELEASE_REPORT_SCHEMA_VERSION;
  releaseId: string;
  manifestDigest: string;
  counts: V2ReleaseReportCounts;
  diffs: readonly V2ResultDiff[];
}>;


function countRightsChanges(
  previous: readonly V2RescanRecord[],
  current: readonly V2RescanRecord[],
): number {
  const oldById = new Map(previous.map((record) => [record.entryId, record]));
  let count = 0;
  for (const record of current) {
    if (oldById.get(record.entryId)?.rightsClass !== undefined && oldById.get(record.entryId)?.rightsClass !== record.rightsClass) count += 1;
  }
  return count;
}

function makeDiffs(previous: readonly V2RescanRecord[], current: readonly V2RescanRecord[]): V2ResultDiff[] {
  const oldById = new Map(previous.map((record) => [record.entryId, record]));
  const newById = new Map(current.map((record) => [record.entryId, record]));
  const ids = [...new Set([...oldById.keys(), ...newById.keys()])].sort((left, right) => left === right ? 0 : left < right ? -1 : 1);
  return ids.map((entryId) => diffV2ResultRecords(oldById.get(entryId), newById.get(entryId))).sort((left, right) => left.entryId === right.entryId ? 0 : left.entryId < right.entryId ? -1 : 1);
}

export function createV2ReleaseReport(
  releaseId: string,
  current: readonly V2RescanRecord[],
  previous: readonly V2RescanRecord[] = [],
): V2ReleaseReport {
  const manifest = makeV2RescanManifest(releaseId, current);
  const prior = makeV2RescanManifest(releaseId, previous);
  const diffs = Object.freeze(makeDiffs(prior.records, manifest.records));
  const counts: V2ReleaseReportCounts = Object.freeze({
    added: diffs.filter((diff) => diff.status === 'ADDED').length,
    removed: diffs.filter((diff) => diff.status === 'REMOVED').length,
    changed: diffs.filter((diff) => diff.status === 'CHANGED').length,
    unchanged: diffs.filter((diff) => diff.status === 'UNCHANGED').length,
    findingChanges: diffs.filter((diff) => diff.findingAdded.length > 0 || diff.findingRemoved.length > 0).length,
    gradeChanges: diffs.filter((diff) => diff.gradeChanged !== undefined).length,
    analysisStatusChanges: diffs.filter((diff) => diff.analysisStatusChanged !== undefined).length,
    authorityChanges: diffs.filter((diff) => diff.authorityChanged.length > 0).length,
    rightsChanges: countRightsChanges(prior.records, manifest.records),
  });
  return Object.freeze({
    schemaVersion: V2_RELEASE_REPORT_SCHEMA_VERSION,
    releaseId,
    manifestDigest: manifest.manifestDigest,
    counts,
    diffs,
  });
}

export function serializeV2ReleaseReport(report: V2ReleaseReport): string {
  return `${canonicalizeJson(report)}\n`;
}

export async function writeV2ReleaseReport(releaseDirectory: string, report: V2ReleaseReport): Promise<string> {
  const filePath = join(releaseDirectory, 'v2-release-report.json');
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(filePath, serializeV2ReleaseReport(report), 'utf8');
  return filePath;
}

