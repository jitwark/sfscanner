import { SEARCH_FIELDS } from './search-config';
import {
  count, MAX_ID_CHARS, MAX_SEARCH_INDEX_DOCUMENTS, parseJsonObject, record, text,
} from './artifact-validation';

export const SEARCH_INDEX_SERIALIZATION_VERSION = 2 as const;
const MAX_SEARCH_INDEX_TERMS = 500_000;

export type SearchIndexArtifact = {
  documentCount: number;
  nextId: number;
  documentIds: Record<string, string>;
  fieldIds: Record<string, number>;
  fieldLength: Record<string, number[]>;
  averageFieldLength: number[];
  storedFields: Record<string, Record<string, unknown>>;
  dirtCount: number;
  index: Array<[string, Record<string, Record<string, number>>]>;
  serializationVersion: typeof SEARCH_INDEX_SERIALIZATION_VERSION;
};

function sequentialIds(value: unknown, total: number): Record<string, string> {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== total) throw new Error('Malformed search index: invalid document map');
  const parsed: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 0; index < total; index++) {
    const id = raw[String(index)];
    if (!text(id, MAX_ID_CHARS) || id.length === 0 || seen.has(id)) throw new Error('Malformed search index: invalid document id');
    parsed[String(index)] = id;
    seen.add(id);
  }
  return parsed;
}

function parseStoredFields(value: unknown, ids: Record<string, string>, total: number): Record<string, Record<string, unknown>> {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== total) throw new Error('Malformed search index: invalid storedFields');
  const parsed: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < total; index++) {
    const key = String(index);
    const row = record(raw[key]);
    if (!row || row.id !== ids[key] || !text(row.slug) || !text(row.title) || !text(row.summary)) {
      throw new Error(`Malformed search index: invalid storedFields row ${key}`);
    }
    for (const field of ['tags', 'integrations', 'triggers', 'capabilities']) {
      if (!Array.isArray(row[field]) || row[field].some((item) => !text(item, 512))) {
        throw new Error(`Malformed search index: invalid storedFields ${field}`);
      }
    }
    if (!text(row.grade, 128) || !text(row.rights, 128) || !text(row.complexity, 128) ||
      typeof row.nodeCount !== 'number' || !Number.isSafeInteger(row.nodeCount) || row.nodeCount < 0 ||
      (row.sourceRepo !== undefined && !text(row.sourceRepo, 2_048)) ||
      (row.descriptionSource !== undefined && !text(row.descriptionSource, 128)) ||
      (row.isIndexable !== undefined && typeof row.isIndexable !== 'boolean') ||
      (row.isPrerendered !== undefined && typeof row.isPrerendered !== 'boolean')) {
      throw new Error(`Malformed search index: invalid storedFields row ${key}`);
    }
    parsed[key] = row;
  }
  return parsed;
}

function parseFieldLength(value: unknown, total: number, fieldCount: number): Record<string, number[]> {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== total) throw new Error('Malformed search index: invalid fieldLength');
  const parsed: Record<string, number[]> = {};
  for (let index = 0; index < total; index++) {
    const row = raw[String(index)];
    if (!Array.isArray(row) || row.length !== fieldCount || row.some((length) => !count(length, Number.MAX_SAFE_INTEGER))) {
      throw new Error('Malformed search index: invalid fieldLength row');
    }
    parsed[String(index)] = [...row];
  }
  return parsed;
}

function parseIndex(value: unknown, documentCount: number, fieldCount: number): Array<[string, Record<string, Record<string, number>>]> {
  if (!Array.isArray(value) || value.length > MAX_SEARCH_INDEX_TERMS) throw new Error('Malformed search index: invalid index');
  const terms = new Set<string>();
  const parsed: Array<[string, Record<string, Record<string, number>>]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !text(entry[0], 2_048) || entry[0].length === 0 || terms.has(entry[0])) {
      throw new Error('Malformed search index: invalid index term');
    }
    const rawFields = record(entry[1]);
    if (!rawFields) throw new Error('Malformed search index: invalid term fields');
    const fields: Record<string, Record<string, number>> = {};
    for (const [fieldId, rawPostings] of Object.entries(rawFields)) {
      const field = Number(fieldId);
      const postings = record(rawPostings);
      if (!Number.isSafeInteger(field) || field < 0 || field >= fieldCount || !postings) {
        throw new Error('Malformed search index: invalid term field');
      }
      const parsedPostings: Record<string, number> = {};
      for (const [shortId, frequency] of Object.entries(postings)) {
        const id = Number(shortId);
        if (!Number.isSafeInteger(id) || id < 0 || id >= documentCount ||
          typeof frequency !== 'number' || !Number.isSafeInteger(frequency) || frequency <= 0) {
          throw new Error('Malformed search index: invalid posting');
        }
        parsedPostings[shortId] = frequency;
      }
      fields[fieldId] = parsedPostings;
    }
    parsed.push([entry[0], fields]);
    terms.add(entry[0]);
  }
  return parsed;
}

/** Validates one MiniSearch v2 JSON artifact before the search engine loads it. */
export function parseSearchIndexArtifact(value: unknown): SearchIndexArtifact {
  const candidate = record(value);
  if (!candidate || candidate.serializationVersion !== SEARCH_INDEX_SERIALIZATION_VERSION) {
    throw new Error('Malformed search index: unsupported serialization version');
  }
  const documentCount = candidate.documentCount;
  const nextId = candidate.nextId;
  if (!count(documentCount) || typeof nextId !== 'number' || !Number.isSafeInteger(nextId) || nextId < documentCount) {
    throw new Error('Malformed search index: invalid document counts');
  }
  const documentIds = sequentialIds(candidate.documentIds, documentCount);
  const rawFieldIds = record(candidate.fieldIds);
  if (!rawFieldIds || Object.keys(rawFieldIds).length !== SEARCH_FIELDS.length ||
    SEARCH_FIELDS.some((field, index) => rawFieldIds[field] !== index)) {
    throw new Error('Malformed search index: invalid fieldIds');
  }
  const fieldIds = Object.fromEntries(SEARCH_FIELDS.map((field, index) => [field, index]));
  const averageFieldLength = candidate.averageFieldLength;
  if (!Array.isArray(averageFieldLength) ||
    (documentCount > 0 && averageFieldLength.length !== SEARCH_FIELDS.length) ||
    (documentCount === 0 && averageFieldLength.length !== 0) ||
    averageFieldLength.some((length) => typeof length !== 'number' || !Number.isFinite(length) || length < 0)) {
    throw new Error('Malformed search index: invalid averageFieldLength');
  }
  const dirtCount = candidate.dirtCount;
  if (!count(dirtCount, nextId)) throw new Error('Malformed search index: invalid dirtCount');
  return {
    documentCount, nextId, documentIds, fieldIds,
    fieldLength: parseFieldLength(candidate.fieldLength, documentCount, SEARCH_FIELDS.length),
    averageFieldLength: [...averageFieldLength],
    storedFields: parseStoredFields(candidate.storedFields, documentIds, documentCount),
    dirtCount,
    index: parseIndex(candidate.index, documentCount, SEARCH_FIELDS.length),
    serializationVersion: SEARCH_INDEX_SERIALIZATION_VERSION,
  };
}

export function parseSearchIndexJson(json: string): SearchIndexArtifact {
  return parseSearchIndexArtifact(parseJsonObject(json, 'search index'));
}
