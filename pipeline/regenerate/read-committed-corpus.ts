import fs from 'node:fs';
import path from 'node:path';
import type { Entry, EntryWithChart, WorkflowChart } from '@hub/contracts';

/**
 * Read the committed corpus a regeneration run works from.
 *
 * Nothing here writes: the run treats `data/` as read-only input and builds its
 * release tree elsewhere. A chart shard and its catalogue shard are positionally
 * aligned, and a pack record is addressed by coordinates the entry publishes, so
 * each reader validates the alignment it depends on rather than trusting it.
 */

const NEWLINE = String.fromCharCode(10);

/** Charts are one JSONL line per catalogue entry, positionally aligned with the shard. */
export function readPackagedItems(dataDir: string): EntryWithChart[] {
  const items: EntryWithChart[] = [];
  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    const entries = JSON.parse(fs.readFileSync(cataloguePath, 'utf8')) as Entry[];
    const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
    const lines = fs.readFileSync(chartPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length !== entries.length) {
      throw new Error(`shard ${shard}: ${entries.length} entries but ${lines.length} charts`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      items.push({ entry: entries[index]!, chart: JSON.parse(lines[index]!) as WorkflowChart });
    }
  }
  return items;
}

/**
 * The redistributable workflow bodies, read from the packs by the coordinates
 * each entry already publishes. Packaging needs them to write the download
 * packs; a body identified by id would silently recover nothing, because a pack
 * record's `id` is n8n's id space, not the catalogue's.
 */
export function readPackWorkflows(items: readonly EntryWithChart[], dataDir: string): Map<string, unknown> {
  const packs = new Map<number, string[]>();
  const workflowsById = new Map<string, unknown>();
  for (const { entry } of items) {
    const download = entry.download;
    if (!download) continue;
    if (!packs.has(download.pack)) {
      const packPath = path.join(dataDir, 'packs', `pack-${download.pack}.jsonl`);
      if (!fs.existsSync(packPath)) continue;
      packs.set(download.pack, fs.readFileSync(packPath, 'utf8').split(NEWLINE));
    }
    const line = packs.get(download.pack)![download.line];
    if (line === undefined) continue;
    try {
      workflowsById.set(entry.id, JSON.parse(line));
    } catch {
      // A malformed pack line leaves the entry with no body; the packager then
      // refuses the run by name rather than shipping an empty download.
    }
  }
  return workflowsById;
}

export function integrationVocabulary(items: readonly EntryWithChart[]): string[] {
  const labels = new Set<string>();
  for (const { entry } of items) for (const label of entry.structure?.integrations ?? []) labels.add(label);
  return [...labels].sort();
}
