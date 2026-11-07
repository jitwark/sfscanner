import { describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION } from '../../contracts/public-data-model.js';
import { makeEntry } from '../../pipeline/__fixtures__/make-entry.js';
import { buildReleaseMetadata, computeReleaseCounts, hashRuleCatalog } from './public-dataset-release-metadata.js';

describe('computeReleaseCounts', () => {
  it('matches the filter buildPublicProjection applies: excludes only rights.status === excluded', () => {
    const entries = [
      makeEntry({ id: 'a', rights: { status: 'redistributable' }, security: { findings: [{ id: 'F1', title: 't', severity: 'LOW', why: 'w', fix: 'f' }] } }),
      makeEntry({ id: 'b', rights: { status: 'link_only' } }),
      makeEntry({ id: 'c', rights: { status: 'excluded' } }),
    ];
    expect(computeReleaseCounts(entries)).toEqual({ workflows: 2, redistributable: 1, linkOnly: 1, excluded: 1, findings: 1 });
  });

  it('counts zero findings and zero excluded on an all-included corpus', () => {
    const entries = [makeEntry({ id: 'a', rights: { status: 'redistributable' } })];
    expect(computeReleaseCounts(entries)).toEqual({ workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 });
  });
});

describe('buildReleaseMetadata', () => {
  it('derives facetCounts.rights from counts, so validateRelease never sees them disagree', () => {
    const metadata = buildReleaseMetadata({
      releaseId: 'release-2026-09-04', generatedAt: '2026-09-04T00:00:00.000Z',
      toolVersion: 'tool@1', scannerVersion: 'scanner-1', policyVersion: 'policy-1', searchIndexVersion: 'search-1',
      buildRevision: 'rev', manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
      counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 0 },
    });
    expect(metadata.schemaVersion).toBe(PUBLIC_DATA_MODEL_SCHEMA_VERSION);
    expect(metadata.facetCounts).toEqual({ rights: { redistributable: 1, linkOnly: 1, excluded: 0 } });
  });
});

describe('hashRuleCatalog', () => {
  it('is deterministic for the same catalog shape', () => {
    const catalog = [{ policyId: 'N8N_CODE_NODE', defaultSeverity: 'LOW' }];
    expect(hashRuleCatalog(catalog)).toBe(hashRuleCatalog(catalog));
  });

  it('changes when the catalog content changes', () => {
    const a = hashRuleCatalog([{ policyId: 'N8N_CODE_NODE' }]);
    const b = hashRuleCatalog([{ policyId: 'N8N_CODE_NODE', defaultSeverity: 'HIGH' }]);
    expect(a).not.toBe(b);
  });

  it('returns a lowercase 64-hex SHA-256', () => {
    expect(hashRuleCatalog({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
