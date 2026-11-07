import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_DIMENSIONS,
  buildSemanticVector,
  cosineSimilarity,
  isSemanticVector,
  normalizeSemanticVector,
  type SemanticIndex,
} from './semantic-search';

describe('semantic search contracts', () => {
  it('accepts only vectors with the fixed dimension', () => {
    expect(isSemanticVector(Array.from({ length: SEMANTIC_DIMENSIONS }, () => 1))).toBe(true);
    expect(isSemanticVector([1, 2, 3])).toBe(false);
    expect(isSemanticVector(Array.from({ length: SEMANTIC_DIMENSIONS }, () => Number.NaN))).toBe(false);
  });

  it('normalizes a valid vector and keeps the zero vector stable', () => {
    const normalized = normalizeSemanticVector([3, 4, ...Array.from({ length: SEMANTIC_DIMENSIONS - 2 }, () => 0)]);
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
    expect(normalizeSemanticVector(Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0))).toEqual(
      Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0),
    );
  });

  it('keeps semantic index records serializable', () => {
    const index: SemanticIndex = { version: 1, dimensions: SEMANTIC_DIMENSIONS, documents: [] };
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });

  it('owns deterministic semantic vector behavior without an app-layer dependency', () => {
    const digest = buildSemanticVector({
      title: 'Inbox summary', summary: 'Daily team update', tags: 'email', integrations: 'gmail',
      trigger: 'schedule', content: 'send a notification digest',
    });
    const notification = buildSemanticVector({
      title: 'Team notification', summary: '', tags: 'chat', integrations: 'slack',
      trigger: 'webhook', content: 'send a message alert',
    });

    expect(digest).toHaveLength(SEMANTIC_DIMENSIONS);
    expect(cosineSimilarity(digest, notification)).toBeGreaterThan(0);
  });
});
