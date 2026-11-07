import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildPublicProjection, type PublicProjectionOptions } from '../export/public-projection.js';
import { writePublicRelease } from '../export/public-release.js';
import { PUBLIC_RELATION_NAMES, type PublicDataProjection } from '@hub/contracts/public-data-model';
import type { Entry } from '@hub/contracts';

const MEASUREMENT_VERSION = 'export-measurement-v1' as const;

export type ExportStageMeasurement = {
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
};

export type ExportTotalMeasurement = ExportStageMeasurement & { peakRssBytes: number };

export type ExportPerformanceReport = {
  measurementVersion: typeof MEASUREMENT_VERSION;
  releaseId: string;
  inputEntryCount: number;
  projection: ExportStageMeasurement & { relationRows: Record<string, number> };
  writers: ExportStageMeasurement & { relationRows: Record<string, number>; artifactBytes: Record<string, number> };
  total: ExportTotalMeasurement;
  peakRssBytes: number;
  rssSource: 'process.resourceUsage.maxRSS' | 'process.memoryUsage.rss-boundaries';
  rssScope: 'whole-process';
};

export type ExportPerformanceOptions = PublicProjectionOptions & { outputDir: string };

function rssBytes(): number { return process.memoryUsage().rss; }

function peakRss(): { bytes: number; source: ExportPerformanceReport['rssSource'] } {
  const maxRss = process.resourceUsage().maxRSS;
  const boundary = rssBytes();
  if (Number.isFinite(maxRss) && maxRss > 0) return { bytes: Math.max(maxRss * 1024, boundary), source: 'process.resourceUsage.maxRSS' };
  return { bytes: boundary, source: 'process.memoryUsage.rss-boundaries' };
}

function elapsedMs(start: number): number { return Number((performance.now() - start).toFixed(3)); }

function measureStage<T>(operation: () => T): { value: T; measurement: ExportStageMeasurement } {
  const start = performance.now();
  const before = rssBytes();
  const value = operation();
  const after = rssBytes();
  return { value, measurement: { elapsedMs: elapsedMs(start), rssBeforeBytes: before, rssAfterBytes: after } };
}

function relationRows(projection: PublicDataProjection): Record<string, number> {
  return Object.fromEntries(PUBLIC_RELATION_NAMES.map((relation) => [relation, projection[relation].length]));
}

function artifactBytes(outputDir: string): Record<string, number> {
  const ndjsonDir = path.join(outputDir, 'ndjson');
  const ndjson = fs.readdirSync(ndjsonDir).reduce((total, file) => total + fs.statSync(path.join(ndjsonDir, file)).size, 0);
  return {
    ndjson,
    sqlite: fs.statSync(path.join(outputDir, 'release.sqlite')).size,
    excel: fs.statSync(path.join(outputDir, 'release.xlsx')).size,
  };
}

function assertRowParity(expected: Record<string, number>, actual: Record<string, number>): void {
  for (const relation of PUBLIC_RELATION_NAMES) {
    if (expected[relation] !== actual[relation]) throw new Error(`Export measurement: ${relation} row-count drift`);
  }
}

export function measurePublicExport(entries: readonly Entry[], options: ExportPerformanceOptions): ExportPerformanceReport {
  const totalStart = performance.now();
  const totalBefore = rssBytes();
  const projectionRun = measureStage(() => buildPublicProjection(entries, options));
  const projectedRows = relationRows(projectionRun.value);
  const writerRun = measureStage(() => writePublicRelease(projectionRun.value, options.outputDir));
  const writerRows = writerRun.value.relations;
  assertRowParity(projectedRows, writerRows);
  const totalAfter = rssBytes();
  const totalPeak = peakRss();
  return {
    measurementVersion: MEASUREMENT_VERSION,
    releaseId: projectionRun.value.release.releaseId,
    inputEntryCount: entries.length,
    projection: { ...projectionRun.measurement, relationRows: projectedRows },
    writers: {
      ...writerRun.measurement,
      relationRows: writerRows,
      artifactBytes: artifactBytes(options.outputDir),
    },
    total: { elapsedMs: elapsedMs(totalStart), rssBeforeBytes: totalBefore, rssAfterBytes: totalAfter, peakRssBytes: totalPeak.bytes },
    peakRssBytes: totalPeak.bytes,
    rssSource: totalPeak.source,
    rssScope: 'whole-process',
  };
}
