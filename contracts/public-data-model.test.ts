import { describe, expect, it } from 'vitest';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_RELATION_NAMES,
  PUBLIC_RELATION_NAMES_V4,
  readPublicWorkflowRows as compatibilityReader,
  type PublicArtifactRow,
  type PublicArtifactRowV4,
  type PublicDataProjection,
  type PublicDataProjectionV4,
  type PublicReleaseMetadataV4,
} from './public-data-model';
import { readPublicWorkflowRows as directReader } from './public-workflow-row-reader';

const refusal = { scannerVersion: '2.0.0', analysisStatus: 'INDETERMINATE', scanFreshness: 'NO_RESULT', scanBodySha256: 'a'.repeat(64) };
const unknownFact = { status: 'unknown', value: null } as const;
describe('public data model contract', () => {
  it('reads a v3 NO_RESULT row only with a bound body and no result status', () => {
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v3', workflows: [{ scanEvidence: refusal, grade: unknownFact, score: unknownFact }] }).schemaVersion).toBe('public-data-model-v3');
    expect(() => compatibilityReader({ schemaVersion: 'public-data-model-v3', workflows: [{ scanEvidence: { ...refusal, analysisStatus: 'COMPLETE' }, grade: unknownFact, score: unknownFact }] })).toThrow(/scan evidence/);
    expect(() => compatibilityReader({ schemaVersion: 'public-data-model-v3', workflows: [{ scanEvidence: { ...refusal, scanBodySha256: null }, grade: unknownFact, score: unknownFact }] })).toThrow(/scan evidence/);
    expect(() => compatibilityReader({ schemaVersion: 'public-data-model-v3', workflows: [{ scanEvidence: refusal, grade: { status: 'known', value: 'LOW' }, score: unknownFact }] })).toThrow(/NO_RESULT/);
  });

  it('exposes stable schema and relation identities', () => {
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION).toBe(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3);
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3).toBe('public-data-model-v3');
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4).toBe('public-data-model-v4');
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2).toBe('public-data-model-v2');
    // The predecessor identity stays exported: `readPublicWorkflowRows` still accepts v1 documents.
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1).toBe('public-data-model-v1');
    expect(PUBLIC_RELATION_NAMES).toEqual([
      'releases',
      'workflows',
      'sources',
      'findings',
      'integrations',
      'tags',
      'triggers',
      'workflowIntegrations',
      'workflowTags',
      'workflowTriggers',
      'credentials',
      'domains',
      'communityNodes',
      'requirements',
      'exclusions',
      'artifacts',
    ]);
    expect(PUBLIC_RELATION_NAMES_V4).toEqual([...PUBLIC_RELATION_NAMES, 'preflightCoverage', 'preflightEvidence']);
  });

  it('loads the runtime graph without a temporal-dead-zone failure', async () => {
    const loaded = await import('./public-data-model');

    expect(loaded.PUBLIC_RELATION_NAMES_V4.slice(-2)).toEqual(['preflightCoverage', 'preflightEvidence']);
    expect(loaded.readPublicWorkflowRows).toBe(directReader);
  });

  it('keeps v3 and v4 relation and schema assignments closed', () => {
    const controls: [
      'preflightCoverage' extends PublicArtifactRow['relation'] ? false : true,
      'preflightEvidence' extends PublicArtifactRow['relation'] ? false : true,
      'preflightEvidence' extends PublicArtifactRowV4['relation'] ? true : false,
      typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION extends PublicReleaseMetadataV4['schemaVersion'] ? false : true,
      typeof PUBLIC_DATA_MODEL_SCHEMA_VERSION extends PublicDataProjectionV4['schemaVersion'] ? false : true,
    ] = [true, true, true, true, true];

    expect(controls).toEqual([true, true, true, true, true]);
  });

  it('describes a serializable rights-aware public projection', () => {
    const projection: PublicDataProjection = {
      schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
      release: {
        releaseId: 'release-2026-08-30',
        schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
        generatedAt: '2026-08-30T00:00:00.000Z',
        toolVersion: 'community-hub-pipeline@1.0.0',
        scannerVersion: 'scanner-v1',
        policyVersion: 'policy-v1',
        searchIndexVersion: 'search-v1',
        buildRevision: 'build-revision',
        manifestSha256: 'a'.repeat(64),
        corpusSha256: 'b'.repeat(64),
        counts: {
          workflows: 1,
          redistributable: 1,
          linkOnly: 0,
          excluded: 0,
          findings: 0,
        },
        facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
      },
      releases: [],
      workflows: [{
        workflowId: 'workflow-1',
        title: '=safe text',
        description: null,
        descriptionAuthority: 'non-authoritative-prose',
        sourceId: 'source-1',
        rightsStatus: 'redistributable',
        body: { kind: 'path', path: 'workflows/workflow-1.json', sha256: 'c'.repeat(64) },
        grade: unknownFact,
        score: unknownFact,
        completeness: 'complete',
        complexity: 'simple',
        nodeCount: 1,
        connectionCount: 0,
        readinessStatus: 'unknown',
        scanEvidence: { scannerVersion: null, analysisStatus: null, scanFreshness: 'UNSCANNED', scanBodySha256: null },
      }],
      sources: [{
        sourceId: 'source-1',
        kind: 'community',
        publicUrl: 'https://example.com/workflow-1',
        repositoryUrl: null,
        licence: 'MIT',
        licenceUrl: 'https://opensource.org/license/mit',
      }],
      findings: [],
      integrations: [],
      tags: [],
      triggers: [],
      workflowIntegrations: [],
      workflowTags: [],
      workflowTriggers: [],
      credentials: [],
      domains: [],
      communityNodes: [],
      requirements: [],
      exclusions: [],
      artifacts: [],
    };

    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(projection.workflows[0]?.body).toEqual({
      kind: 'path',
      path: 'workflows/workflow-1.json',
      sha256: 'c'.repeat(64),
    });
  });
});

describe('public workflow row reader extraction', () => {
  const currentEvidence = {
    scannerVersion: '2.0.0',
    analysisStatus: 'COMPLETE',
    scanFreshness: 'CURRENT',
    scanBodySha256: 'b'.repeat(64),
  } as const;
  const v1Row = { workflowId: 'workflow-v1' };
  const v2Row = { workflowId: 'workflow-v2', scanEvidence: currentEvidence };
  const v3Row = { workflowId: 'workflow-v3', scanEvidence: refusal, grade: unknownFact, score: unknownFact };
  const readers = [compatibilityReader, directReader] as const;

  it('keeps the model compatibility export identical to the direct reader', () => {
    expect(compatibilityReader).toBe(directReader);
  });

  it('preserves v1 positive rows and rejects v1 scan evidence', () => {
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v1', workflows: [v1Row] })).toEqual({
      schemaVersion: 'public-data-model-v1',
      workflows: [v1Row],
    });

    for (const reader of readers) {
      expect(() => reader({ schemaVersion: 'public-data-model-v1', workflows: [{ ...v1Row, scanEvidence: {} }] }))
        .toThrow('Public model: a public-data-model-v1 row carries scan evidence, which v1 does not define');
    }
  });

  it('preserves the v2 CURRENT boundary and rejects NO_RESULT', () => {
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v2', workflows: [v2Row] })).toEqual({
      schemaVersion: 'public-data-model-v2',
      workflows: [v2Row],
    });

    for (const reader of readers) {
      expect(() => reader({
        schemaVersion: 'public-data-model-v2',
        workflows: [{ ...v2Row, scanEvidence: { ...currentEvidence, scanFreshness: 'NO_RESULT' } }],
      })).toThrow('Public model: a public-data-model-v2 workflow row carries no valid scan evidence');
    }
  });

  it.each([PUBLIC_DATA_MODEL_SCHEMA_VERSION_V3, PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4])(
    'preserves the %s NO_RESULT boundary through both import paths',
    (schemaVersion) => {
      for (const reader of readers) {
        expect(reader({ schemaVersion, workflows: [v3Row] })).toEqual({
          schemaVersion,
          workflows: [v3Row],
        });
        expect(() => reader({
          schemaVersion,
          workflows: [{ ...v3Row, scanEvidence: { ...refusal, analysisStatus: 'COMPLETE' } }],
        })).toThrow(/scan evidence/);
        expect(() => reader({
          schemaVersion,
          workflows: [{ ...v3Row, scanEvidence: { ...refusal, scanBodySha256: null } }],
        })).toThrow(/scan evidence/);
        expect(() => reader({
          schemaVersion,
          workflows: [{ ...v3Row, grade: { status: 'known', value: 'LOW' } }],
        })).toThrow('Public model: a NO_RESULT row must publish an unknown assessment and score');
        expect(() => reader({
          schemaVersion,
          workflows: [{ ...v3Row, score: { status: 'known', value: 40 } }],
        })).toThrow('Public model: a NO_RESULT row must publish an unknown assessment and score');
      }
    },
  );

  it('preserves structural failures through both import paths', () => {
    for (const reader of readers) {
      expect(() => reader(null)).toThrow('Public model: document is not an object');
      expect(() => reader({ schemaVersion: 'public-data-model-v5', workflows: [] })).toThrow('Public model: unsupported schema version');
      expect(() => reader({ schemaVersion: 'public-data-model-v3' })).toThrow('Public model: workflows relation is not an array');
    }
  });

  it('returns the original workflow arrays without cloning or relabeling rows', () => {
    const v1Workflows = [v1Row];
    const v2Workflows = [v2Row];
    const v3Workflows = [v3Row];
    const v4Workflows = [v3Row];

    expect(compatibilityReader({ schemaVersion: 'public-data-model-v1', workflows: v1Workflows }).workflows).toBe(v1Workflows);
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v2', workflows: v2Workflows }).workflows).toBe(v2Workflows);
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v3', workflows: v3Workflows }).workflows).toBe(v3Workflows);
    expect(compatibilityReader({ schemaVersion: 'public-data-model-v4', workflows: v4Workflows }).workflows).toBe(v4Workflows);
  });
});
