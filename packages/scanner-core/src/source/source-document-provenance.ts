import type { ReadonlySourceDocumentV2 } from './source-types';

const parserDocuments = new WeakSet<object>();

export function markParsedSourceDocument(document: ReadonlySourceDocumentV2): void {
  parserDocuments.add(document as object);
}

export function isParsedSourceDocument(value: unknown): value is ReadonlySourceDocumentV2 {
  return typeof value === 'object' && value !== null && parserDocuments.has(value);
}
