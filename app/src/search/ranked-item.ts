import { normalizeTaxonomyValue, qualityScore } from '@hub/contracts';
import type { RankedSearchDisplayItem } from './worker-messages';

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? value.split(' ').filter(Boolean) : [];
}

/**
 * Turns one index's stored fields into a display item.
 *
 * Every field is read defensively rather than cast: these values come out of a
 * JSON artifact built by a different process, and a shape change there should
 * degrade one row rather than throw inside the worker, where the failure would
 * take out search entirely.
 */
export function toRankedItem(id: string, doc: Record<string, unknown>): RankedSearchDisplayItem {
  const item: RankedSearchDisplayItem = {
    id,
    slug: typeof doc.slug === 'string' ? doc.slug : '',
    title: typeof doc.title === 'string' ? doc.title : '',
    summary: typeof doc.summary === 'string' ? doc.summary : '',
    tags: strings(doc.tags),
    integrations: strings(doc.integrations),
    triggers: strings(doc.triggers).map((value) => normalizeTaxonomyValue('trigger', value)),
    capabilities: strings(doc.capabilities).map((value) => normalizeTaxonomyValue('capability', value)),
    grade: normalizeTaxonomyValue('security', doc.grade),
    rights: normalizeTaxonomyValue('rights', doc.rights),
    complexity: normalizeTaxonomyValue('complexity', doc.complexity),
    nodeCount: typeof doc.nodeCount === 'number' ? doc.nodeCount : 0,
    sourceRepo: typeof doc.sourceRepo === 'string' ? doc.sourceRepo : undefined,
    descriptionSource: typeof doc.descriptionSource === 'string' ? doc.descriptionSource : undefined,
    isIndexable: typeof doc.isIndexable === 'boolean' ? doc.isIndexable : undefined,
    isPrerendered: typeof doc.isPrerendered === 'boolean' ? doc.isPrerendered : undefined,
  };
  item.qualityScore = qualityScore(item);
  return item;
}
