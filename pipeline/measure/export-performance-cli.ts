import fs from 'node:fs';
import { measurePublicExport } from './export-performance.js';
import type { Entry } from '@hub/contracts';
import type { PublicReleaseMetadata } from '@hub/contracts/public-data-model';

export function runExportPerformanceCli(args: readonly string[]): string {
  const requiredFlag = (flag: string): string => {
    const index = args.indexOf(flag);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (!value) throw new Error(`Usage: export-performance-cli --entries <entries.json> --release <release.json> --output <directory> [--body-sha256 <hashes.json>]`);
    return value;
  };
  const entriesPath = requiredFlag('--entries');
  const releasePath = requiredFlag('--release');
  const outputDir = requiredFlag('--output');
  const bodyShaPath = args.includes('--body-sha256') ? requiredFlag('--body-sha256') : undefined;
  const entries = JSON.parse(fs.readFileSync(entriesPath, 'utf8')) as unknown;
  if (!Array.isArray(entries)) throw new Error(`Entries input must be a JSON array: ${entriesPath}`);
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8')) as PublicReleaseMetadata;
  const bodySha256ByWorkflowId = bodyShaPath
    ? JSON.parse(fs.readFileSync(bodyShaPath, 'utf8')) as Record<string, string | undefined>
    : undefined;
  const report = measurePublicExport(entries as Entry[], { outputDir, release, bodySha256ByWorkflowId });
  return JSON.stringify({ entriesPath, releasePath, outputDir, ...report }, null, 2);
}

if (process.argv[1]?.endsWith('export-performance-cli.ts')) {
  try { console.log(runExportPerformanceCli(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
