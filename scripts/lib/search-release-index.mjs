const FIELDS = Object.freeze([
  'id', 'title', 'summary', 'tags', 'integrations', 'triggers', 'capabilities', 'content',
]);
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DOCUMENTS = 50_000;
const MAX_TERMS = 500_000;

function malformed(label, message) {
  throw new Error(`Malformed ${label}: ${message}`);
}

function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.keys(value).some((key) => DANGEROUS.has(key)) ? null : value;
}

function count(value, max) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function text(value, max = 16_384) {
  return typeof value === 'string' && value.length <= max;
}

function sequentialIds(value, total, label) {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== total) malformed(label, 'invalid document map');
  const ids = []; const seen = new Set();
  for (let index = 0; index < total; index++) {
    const documentId = raw[String(index)];
    if (!text(documentId, 256) || documentId.length === 0 || seen.has(documentId)) {
      malformed(label, 'invalid document id');
    }
    ids.push(documentId); seen.add(documentId);
  }
  return ids;
}

function storedFields(value, ids, label) {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== ids.length) malformed(label, 'invalid storedFields');
  for (let index = 0; index < ids.length; index++) {
    const key = String(index); const row = record(raw[key]);
    if (!row || row.id !== ids[index] || !text(row.slug) || !text(row.title) || !text(row.summary)) {
      malformed(label, `invalid storedFields row ${key}`);
    }
    for (const field of ['tags', 'integrations', 'triggers', 'capabilities']) {
      if (!Array.isArray(row[field]) || row[field].some((item) => !text(item, 512))) {
        malformed(label, `invalid storedFields ${field}`);
      }
    }
    if (!text(row.grade, 128) || !text(row.rights, 128) || !text(row.complexity, 128) ||
      typeof row.nodeCount !== 'number' || !Number.isSafeInteger(row.nodeCount) || row.nodeCount < 0 ||
      (row.sourceRepo !== undefined && !text(row.sourceRepo, 2_048)) ||
      (row.descriptionSource !== undefined && !text(row.descriptionSource, 128)) ||
      (row.isIndexable !== undefined && typeof row.isIndexable !== 'boolean') ||
      (row.isPrerendered !== undefined && typeof row.isPrerendered !== 'boolean')) {
      malformed(label, `invalid storedFields row ${key}`);
    }
  }
}

function fieldLengths(value, total, label) {
  const raw = record(value);
  if (!raw || Object.keys(raw).length !== total) malformed(label, 'invalid fieldLength');
  for (let index = 0; index < total; index++) {
    const row = raw[String(index)];
    if (!Array.isArray(row) || row.length !== FIELDS.length ||
      row.some((length) => !count(length, Number.MAX_SAFE_INTEGER))) {
      malformed(label, 'invalid fieldLength row');
    }
  }
}

function invertedIndex(value, documentCount, label) {
  if (!Array.isArray(value) || value.length > MAX_TERMS) malformed(label, 'invalid index');
  const terms = new Set();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !text(entry[0], 2_048) ||
      entry[0].length === 0 || terms.has(entry[0])) malformed(label, 'invalid index term');
    const fields = record(entry[1]);
    if (!fields) malformed(label, 'invalid term fields');
    for (const [fieldId, rawPostings] of Object.entries(fields)) {
      const field = Number(fieldId); const postings = record(rawPostings);
      if (!Number.isSafeInteger(field) || field < 0 || field >= FIELDS.length || !postings) {
        malformed(label, 'invalid term field');
      }
      for (const [shortId, frequency] of Object.entries(postings)) {
        const id = Number(shortId);
        if (!Number.isSafeInteger(id) || id < 0 || id >= documentCount ||
          typeof frequency !== 'number' || !Number.isSafeInteger(frequency) || frequency <= 0) {
          malformed(label, 'invalid posting');
        }
      }
    }
    terms.add(entry[0]);
  }
}

/** Mirrors contracts/search-index-artifact.ts for the Node maintenance runtime. */
export function validateSearchIndexArtifact(value, label = 'search index') {
  const candidate = record(value);
  if (!candidate || candidate.serializationVersion !== 2) {
    malformed(label, 'unsupported serialization version');
  }
  const documentCount = candidate.documentCount; const nextId = candidate.nextId;
  if (!count(documentCount, MAX_DOCUMENTS) || typeof nextId !== 'number' ||
    !Number.isSafeInteger(nextId) || nextId < documentCount) {
    malformed(label, 'invalid document counts');
  }
  const ids = sequentialIds(candidate.documentIds, documentCount, label);
  const fieldIds = record(candidate.fieldIds);
  if (!fieldIds || Object.keys(fieldIds).length !== FIELDS.length ||
    FIELDS.some((field, index) => fieldIds[field] !== index)) {
    malformed(label, 'invalid fieldIds');
  }
  const averages = candidate.averageFieldLength;
  if (!Array.isArray(averages) || (documentCount > 0 && averages.length !== FIELDS.length) ||
    (documentCount === 0 && averages.length !== 0) ||
    averages.some((length) => typeof length !== 'number' || !Number.isFinite(length) || length < 0)) {
    malformed(label, 'invalid averageFieldLength');
  }
  if (!count(candidate.dirtCount, nextId)) malformed(label, 'invalid dirtCount');
  fieldLengths(candidate.fieldLength, documentCount, label);
  storedFields(candidate.storedFields, ids, label);
  invertedIndex(candidate.index, documentCount, label);
  return { documentCount, nextId, documentIds: ids };
}
