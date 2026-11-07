import fs from 'node:fs';
import path from 'node:path';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';

/** Argument grammar and validation for the v2 regeneration driver; no corpus or body I/O. */
export type V2CliArguments = Readonly<{
  /** The committed corpus to read. Never written to. */
  dataDir: string;
  /** The C1 `corpus-v2-input-inventory-v1` receipt, raw or wrapped in its dated report. */
  inventoryPath: string;
  /** Where the report and the retained records go. Absent means a dry run writes nothing. */
  outDir?: string;
  /** Where the complete candidate release tree is written. Absent means no tree is written. */
  applyDataDir?: string;
  /** An already-written retained-record sidecar, replayed instead of scanning the corpus again. */
  recordsPath?: string;
  /** Frozen release timestamp, required when a release tree is written. */
  generatedAt?: string;
  /** The `official-body-map-v1` artifact whose bound folders `bodySources` declares. */
  mapPath?: string;
  bodySources: readonly string[];
  /**
   * A private cache of bodies re-fetched at their recorded pinned source, named `<entryId>.<16-hex>.json`.
   * Only inventory rows classified AVAILABLE with a GITHUB identity are read from it.
   */
  hydratedDir?: string;
}>;

/**
 * The one error a malformed command line produces. The message names the offending option — at most
 * a flag name, never a value — so a caller that catches this type can print the grammar again.
 */
export class V2CliUsageError extends Error {}

/** Same echo bound as `public-dataset-arguments.ts`: `--` plus 62 characters, a flag name only. */
const FLAG_SHAPED = /^--[a-z][a-z0-9-]{0,61}$/;
const VALUE_OPTIONS = ['--data', '--inventory', '--out', '--map', '--bodies', '--hydrated', '--records', '--apply-data', '--generated-at'] as const;

export const USAGE = [
  'Usage: npx tsx pipeline/regenerate/v2-cli.ts --data <dir> --inventory <file> [--out <dir>]',
  '                                               [--map <file> --bodies <dir> ...]',
  '  --data <dir>        committed corpus directory to read (required, never written)',
  '  --inventory <file>  C1 corpus-v2-input-inventory-v1 receipt (required)',
  '  --out <dir>         write the run report and the retained records here (default: dry run)',
  '  --map <file>        official-body-map-v1 artifact; with --bodies, bodies are read and scanned',
  '  --bodies <dir>      a folder the map bound; repeat once per bound folder',
  '  --hydrated <dir>    private cache of <entryId>.json bodies fetched at their pinned source',
  '  --records <file>    replay an existing v2-scan-evidence.ndjson instead of scanning again',
  '  --apply-data <dir>  write the complete candidate release tree here (requires --generated-at)',
  '  --generated-at <iso> frozen release timestamp for --apply-data',
].join('\n');

/** Containment on resolved paths: the root itself counts, a sibling prefix and `..` do not. */
function canonical(value: string): string | null {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseV2CliArguments(argv: readonly string[], cwd: string): V2CliArguments {
  const values = new Map<string, string>();
  const bodySources: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const name = FLAG_SHAPED.test(token) && (VALUE_OPTIONS as readonly string[]).includes(token) ? token : null;
    if (name === null) throw new V2CliUsageError(`unknown option: ${FLAG_SHAPED.test(token) ? token : 'unexpected argument'}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new V2CliUsageError(`${name} requires a value`);
    index += 1;
    if (name === '--bodies') {
      bodySources.push(value);
      continue;
    }
    if (values.has(name)) throw new V2CliUsageError(`${name} was given twice`);
    values.set(name, value);
  }

  const data = values.get('--data');
  const inventory = values.get('--inventory');
  const map = values.get('--map');
  if (data === undefined) throw new V2CliUsageError('--data is required: this run never guesses the corpus directory');
  if (inventory === undefined) throw new V2CliUsageError('--inventory is required: this run never guesses the input receipt');
  if (map !== undefined && bodySources.length === 0) {
    throw new V2CliUsageError('--map requires at least one --bodies <dir>: the folders the map bound must be declared');
  }
  if (bodySources.length > 0 && map === undefined) {
    throw new V2CliUsageError('--bodies requires --map <file>: bodies are read from the map that bound them');
  }

  const dataDir = path.resolve(cwd, data);
  const out = values.get('--out');
  const hydrated = values.get('--hydrated');
  const records = values.get('--records');
  const applyData = values.get('--apply-data');
  const generatedAt = values.get('--generated-at');
  const dataCanonical = canonical(dataDir);
  const outCanonical = out === undefined ? undefined : canonical(path.resolve(cwd, out));
  const applyCanonical = applyData === undefined ? undefined : canonical(path.resolve(cwd, applyData));
  if (dataCanonical === null || (out !== undefined && outCanonical === null) || (applyData !== undefined && applyCanonical === null)) {
    throw new V2CliUsageError('a write destination cannot be resolved to an existing ancestor; refusing to guess containment');
  }
  if (outCanonical != null && isInside(dataCanonical, outCanonical)) {
    throw new V2CliUsageError('--out must not be inside --data: a run never writes into its own corpus');
  }
  if (applyCanonical != null && isInside(dataCanonical, applyCanonical)) {
    throw new V2CliUsageError('--apply-data must not be inside --data: a run never writes into its own corpus');
  }
  if (applyData !== undefined && generatedAt === undefined) {
    throw new V2CliUsageError('--apply-data requires --generated-at: a release tree never reads the clock');
  }
  if (generatedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T/.test(generatedAt)) {
    throw new V2CliUsageError('--generated-at must be an ISO-8601 timestamp');
  }

  return Object.freeze({
    dataDir,
    inventoryPath: path.resolve(cwd, inventory),
    bodySources: Object.freeze(bodySources.map((dir) => path.resolve(cwd, dir))),
    ...(out === undefined ? {} : { outDir: path.resolve(cwd, out) }),
    ...(hydrated === undefined ? {} : { hydratedDir: path.resolve(cwd, hydrated) }),
    ...(records === undefined ? {} : { recordsPath: path.resolve(cwd, records) }),
    ...(applyData === undefined ? {} : { applyDataDir: path.resolve(cwd, applyData) }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(map === undefined ? {} : { mapPath: path.resolve(cwd, map) }),
  });
}

/**
 * The fields this run reads, checked before they are read: either the inventory artifact itself, or
 * the dated report (`C1-real-inventory.json`) that wraps the inventory it was derived from.
 */
