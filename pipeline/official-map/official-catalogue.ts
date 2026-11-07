import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Reading the catalogue's `n8n_official` entries out of the committed shards.
 *
 * The corpus is untrusted JSON, so only the properties a caller needs are read
 * and each one is checked. A shape assumption here would be a silent mis-join —
 * one template's verdicts attributed to another template's entry — rather than a
 * loud failure.
 */

/**
 * Shards are numbered from zero. A gap in the middle would silently drop entries
 * and break the reconciliation, so a missing shard stops the read rather than
 * being skipped.
 */
export function readCatalogueShards(dataDir: string): unknown[][] {
  const shards: unknown[][] = [];
  for (let index = 0; ; index += 1) {
    const file = path.join(dataDir, `catalogue-${index}.json`);
    try {
      statSync(file);
    } catch {
      if (index === 0) throw new Error(`no catalogue-0.json under ${dataDir}`);
      return shards;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`);
    shards.push(parsed);
  }
}

export type OfficialCatalogueSide = {
  /** templateId -> entryId, for every official entry carrying an integer templateId. */
  byTemplate: Map<number, string>;
  /** Entries sharing a templateId. Non-zero makes the join ambiguous. */
  duplicates: number;
  /** Official entries carrying no integer `source.templateId`. */
  missingTemplateId: number;
  /** Every `source.kind === 'n8n_official'` entry seen, keyless ones included. */
  total: number;
};

export function readOfficialCatalogueSide(shards: readonly (readonly unknown[])[]): OfficialCatalogueSide {
  const byTemplate = new Map<number, string>();
  let duplicates = 0;
  let missingTemplateId = 0;
  let total = 0;
  for (const shard of shards) {
    for (const item of shard) {
      if (typeof item !== 'object' || item === null || !('source' in item)) continue;
      const source = item.source;
      if (typeof source !== 'object' || source === null || !('kind' in source)) continue;
      if (source.kind !== 'n8n_official') continue;
      total += 1;
      const templateId = 'templateId' in source ? source.templateId : undefined;
      if (typeof templateId !== 'number' || !Number.isSafeInteger(templateId)) {
        missingTemplateId += 1;
        continue;
      }
      const entryId = 'id' in item && typeof item.id === 'string' ? item.id : '';
      if (byTemplate.has(templateId)) duplicates += 1;
      // Last write wins for a duplicate; `duplicates` is what makes the caller
      // refuse, so the join never silently resolves an ambiguity.
      byTemplate.set(templateId, entryId);
    }
  }
  return { byTemplate, duplicates, missingTemplateId, total };
}
