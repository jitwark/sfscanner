import { TAG_GROUPS, type FacetCounts, type FacetData, type NormalizedTag, type TagGroup } from './discovery';
import { count, MAX_ID_CHARS, parseJsonObject, record, text } from './artifact-validation';

const MAX_FACET_VALUES = 20_000;
const MAX_FACETS = 500;

export type FacetDataPayload = Omit<FacetData, 'facets'>;

function parseCounts(value: unknown, total: number): FacetCounts {
  const raw = record(value);
  const groups = ['rights', 'grade', 'trigger', 'complexity', 'capabilities', 'integrations', 'tags'] as const;
  if (!raw || groups.some((group) => !record(raw[group]))) throw new Error('Malformed facets: invalid counts');
  const parsed = {} as FacetCounts;
  for (const group of groups) {
    const source = raw[group] as Record<string, unknown>;
    const target: Record<string, number> = {};
    if (Object.keys(source).length > MAX_FACET_VALUES) throw new Error('Malformed facets: too many count values');
    for (const [key, value] of Object.entries(source)) {
      if (!text(key, 512) || key.length === 0 || !count(value, total)) throw new Error('Malformed facets: invalid count');
      target[key] = value;
    }
    parsed[group] = target;
  }
  return parsed;
}

function base64Bytes(value: unknown): number | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Validates the payload needed by the worker; the display facet list is optional there. */
export function parseFacetPayload(value: unknown): FacetDataPayload {
  const candidate = record(value);
  const total = candidate?.total;
  if (!candidate || !count(total)) throw new Error('Malformed facets: invalid total');
  const ordinals = candidate.ordinals;
  if (!Array.isArray(ordinals) || ordinals.length !== total) throw new Error('Malformed facets: invalid ordinals');
  const seen = new Set<string>();
  const parsedOrdinals = ordinals.map((id) => {
    if (!text(id, MAX_ID_CHARS) || id.length === 0 || seen.has(id)) throw new Error('Malformed facets: invalid ordinal');
    seen.add(id);
    return id;
  });
  const rawBitsets = record(candidate.bitsets);
  if (!rawBitsets || Object.keys(rawBitsets).length > MAX_FACET_VALUES) throw new Error('Malformed facets: invalid bitsets');
  const expectedBytes = Math.ceil(total / 32) * 4;
  const bitsets: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawBitsets)) {
    if (!text(key, 512) || key.length === 0 || base64Bytes(value) !== expectedBytes) throw new Error('Malformed facets: invalid bitset');
    bitsets[key] = value as string;
  }
  return { total, counts: parseCounts(candidate.counts, total), bitsets, ordinals: parsedOrdinals };
}

/** Validates facet counts, ordinals, and bitsets as one cross-dependent artifact. */
export function parseFacetData(value: unknown): FacetData {
  const core = parseFacetPayload(value);
  const total = core.total;
  const candidate = record(value);
  const rawFacets = candidate?.facets;
  if (!Array.isArray(rawFacets) || rawFacets.length > MAX_FACETS) throw new Error('Malformed facets: invalid facet list');
  const facets: NormalizedTag[] = rawFacets.map((value) => {
    const facet = record(value);
    if (!facet || !text(facet.slug, 512) || !text(facet.label, 512) || !TAG_GROUPS.includes(facet.group as TagGroup) ||
      !count(facet.count, total)) throw new Error('Malformed facets: invalid facet');
    return { slug: facet.slug, label: facet.label, group: facet.group as TagGroup, count: facet.count };
  });
  return { ...core, facets };
}

export function parseFacetJson(json: string): FacetData {
  return parseFacetData(parseJsonObject(json, 'facets'));
}
