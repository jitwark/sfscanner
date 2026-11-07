import { SEMANTIC_DIMENSIONS, isSemanticVector, type SemanticIndex } from './semantic-search';
import { count, MAX_ID_CHARS, parseJsonObject, record, text } from './artifact-validation';

function validOrdinals(value: unknown): value is string[] {
  if (!Array.isArray(value) || !count(value.length)) return false;
  const seen = new Set<string>();
  for (const id of value) {
    if (!text(id, MAX_ID_CHARS) || id.length === 0 || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Validates the lazy semantic artifact and returns a narrowed, sanitized shape. */
export function parseSemanticIndexArtifact(value: unknown): SemanticIndex {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1 || candidate.dimensions !== SEMANTIC_DIMENSIONS ||
    !Array.isArray(candidate.documents) || !count(candidate.documents.length)) {
    throw new Error('Malformed semantic index: invalid header');
  }
  const ordinals = candidate.ordinals;
  if (ordinals !== undefined && !validOrdinals(ordinals)) {
    throw new Error('Malformed semantic index: invalid ordinals');
  }
  const ids = new Set<string>();
  const documents = candidate.documents.map((value) => {
    const document = record(value);
    if (!document || !text(document.id, MAX_ID_CHARS) || document.id.length === 0 || ids.has(document.id) ||
      !isSemanticVector(document.vector)) throw new Error('Malformed semantic index: invalid vector document');
    ids.add(document.id);
    return { id: document.id, vector: [...document.vector] };
  });
  return { version: 1, dimensions: SEMANTIC_DIMENSIONS, ...(ordinals === undefined ? {} : { ordinals: [...ordinals] }), documents };
}

export function parseSemanticIndexJson(json: string): SemanticIndex {
  return parseSemanticIndexArtifact(parseJsonObject(json, 'semantic index'));
}
