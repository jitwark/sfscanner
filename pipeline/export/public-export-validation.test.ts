import { describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { buildPublicProjection } from './public-projection.js';
import { assertPublicProjection } from './public-export-validation.js';

const release: PublicReleaseMetadata = {
  releaseId: 'release-validation-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-31T00:00:00.000Z', toolVersion: 'hub-pipeline@test', scannerVersion: 'scanner-test',
  policyVersion: 'policy-test', searchIndexVersion: 'search-test', buildRevision: 'revision-test',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
};

function projection() {
  return buildPublicProjection([makeEntry({ id: 'one', download: { pack: 0, line: 1, offset: 0, length: 10 } })], {
    release, bodySha256ByWorkflowId: { one: 'c'.repeat(64) },
  });
}

describe('public projection validation', () => {
  it('accepts a canonical projection', () => {
    expect(assertPublicProjection(projection())).toBe(true);
  });

  it('rejects more than one release row before any format writer runs', () => {
    const data = projection();
    const invalid = { ...data, releases: [data.release, { ...data.release, releaseId: 'release-other' }] };
    expect(() => assertPublicProjection(invalid)).toThrow(/exactly one canonical release/i);
  });

  it('rejects artifacts that do not belong to the canonical release or have unsafe metadata', () => {
    const data = projection();
    const artifact = {
      artifactId: 'artifact-one', releaseId: 'release-other', relation: 'workflows' as const,
      format: 'ndjson' as const, path: 'workflows.ndjson', sha256: 'd'.repeat(64), byteSize: 12,
      rightsStatus: 'redistributable' as const,
    };
    expect(() => assertPublicProjection({ ...data, artifacts: [artifact] })).toThrow(/invalid artifact/i);
    expect(() => assertPublicProjection({ ...data, artifacts: [{ ...artifact, releaseId: release.releaseId, byteSize: -1 }] })).toThrow(/invalid artifact/i);
    expect(() => assertPublicProjection({ ...data, artifacts: [{ ...artifact, releaseId: release.releaseId, relation: 'private' as never }] })).toThrow(/invalid artifact/i);
  });

  it('rejects malformed workflow body references instead of trusting the typed shape', () => {
    const data = projection();
    const workflow = data.workflows[0]!;
    const invalid = {
      ...data,
      workflows: [{
        ...workflow,
        body: { kind: 'path' as const, path: '../private-workflow.jsonl', sha256: 'c'.repeat(64) },
      }],
    };
    expect(() => assertPublicProjection(invalid)).toThrow(/invalid body reference/i);
  });
});
