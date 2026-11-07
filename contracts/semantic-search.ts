import { aliasesFor } from './search-aliases';

/** Fixed-size, deterministic vectors used by the offline semantic index. */
export const SEMANTIC_DIMENSIONS = 96;

export type SemanticDocument = { id: string; vector: number[] };
export type SemanticIndex = {
  version: 1;
  dimensions: typeof SEMANTIC_DIMENSIONS;
  /** Catalogue order used for facets and result ordinals; independent of MiniSearch internals. */
  ordinals?: string[];
  documents: SemanticDocument[];
};

export function isSemanticVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === SEMANTIC_DIMENSIONS &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

export function normalizeSemanticVector(vector: number[]): number[] {
  if (!isSemanticVector(vector)) return Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0);
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return [...vector];
  return vector.map((value) => value / magnitude);
}

export type SemanticSearchText = {
  title: string; summary: string; tags: string; integrations: string; trigger: string; content: string;
};

const FIELD_WEIGHTS: Array<[keyof SemanticSearchText, number]> = [
  ['title', 4], ['tags', 3], ['integrations', 2], ['trigger', 1.5], ['content', 1.25], ['summary', 1],
];

function tokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((token) => token.length > 1).slice(0, 2000);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const first = hash(feature) % SEMANTIC_DIMENSIONS;
  const second = hash(`${feature}:sign`) % SEMANTIC_DIMENSIONS;
  vector[first] += weight;
  vector[second] -= weight * 0.35;
}

export function buildSemanticVector(text: SemanticSearchText): number[] {
  const vector = Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0);
  for (const [field, weight] of FIELD_WEIGHTS) {
    for (const token of tokens(text[field])) {
      addFeature(vector, token, weight);
      for (const alias of aliasesFor(token)) addFeature(vector, alias, weight * 0.35);
    }
  }
  return normalizeSemanticVector(vector);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length !== SEMANTIC_DIMENSIONS) return 0;
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
