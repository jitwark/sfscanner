import { describe, expect, it } from 'vitest';
import { SEARCH_FIELDS } from './search-config';
import { MAX_SEARCH_ARTIFACT_CHARS } from './artifact-validation';
import { parseFacetData } from './facet-artifact';
import { parseSearchIndexArtifact, parseSearchIndexJson } from './search-index-artifact';
import { parseSemanticIndexArtifact } from './semantic-index-artifact';

const fieldIds = Object.fromEntries(SEARCH_FIELDS.map((field, index) => [field, index]));
const validIndex = () => ({
  documentCount: 1,
  nextId: 1,
  documentIds: { '0': 'workflow-1' },
  fieldIds,
  fieldLength: { '0': SEARCH_FIELDS.map(() => 1) },
  averageFieldLength: SEARCH_FIELDS.map(() => 1),
  storedFields: {
    '0': {
      id: 'workflow-1', slug: 'workflow-1', title: 'Workflow', summary: 'A workflow',
      tags: [], integrations: [], triggers: ['manual'], capabilities: [], grade: 'LOW',
      rights: 'redistributable', complexity: 'simple', nodeCount: 1,
    },
  },
  dirtCount: 0,
  index: [['workflow', { '1': { '0': 1 } }]],
  serializationVersion: 2,
});

const validFacets = {
  total: 1,
  counts: { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} },
  facets: [],
  bitsets: { 'rights:redistributable': 'AQAAAA==' },
  ordinals: ['workflow-1'],
};

describe('search artifact contracts', () => {
  it('accepts the MiniSearch serialization used by the packaged tiers', () => {
    expect(parseSearchIndexArtifact(validIndex()).documentCount).toBe(1);
  });

  it('rejects unsupported, inconsistent, or oversized lexical payloads', () => {
    expect(() => parseSearchIndexArtifact({ ...validIndex(), serializationVersion: 1 })).toThrow(/version/i);
    expect(() => parseSearchIndexArtifact({ ...validIndex(), storedFields: {} })).toThrow(/storedFields/i);
    expect(() => parseSearchIndexJson('x'.repeat(MAX_SEARCH_ARTIFACT_CHARS + 1))).toThrow(/large|size/i);
  });

  it('accepts MiniSearch’s valid empty-tier representation', () => {
    const empty = validIndex();
    empty.documentCount = 0;
    empty.nextId = 0;
    empty.documentIds = {};
    empty.fieldLength = {};
    empty.averageFieldLength = [];
    empty.storedFields = {};
    empty.index = [];
    empty.dirtCount = 0;

    expect(parseSearchIndexArtifact(empty).documentCount).toBe(0);
  });

  it('rejects malformed semantic vectors and facet bitsets', () => {
    expect(parseSemanticIndexArtifact({ version: 1, dimensions: 96, documents: [] }).documents).toEqual([]);
    expect(() => parseSemanticIndexArtifact({
      version: 1, dimensions: 96, documents: [{ id: 'x', vector: [1] }],
    })).toThrow(/vector/i);
    expect(() => parseSemanticIndexArtifact({
      version: 1, dimensions: 96, ordinals: ['same', 'same'], documents: [],
    })).toThrow(/ordinal/i);
    expect(parseFacetData(validFacets).ordinals).toEqual(['workflow-1']);
    expect(() => parseFacetData({ ...validFacets, bitsets: { bad: 'AQ==' } })).toThrow(/bitset/i);
    expect(() => parseFacetData({ ...validFacets, ordinals: [] })).toThrow(/ordinal/i);
  });
});
