import { describe, expect, it } from 'vitest';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_RELATION_NAMES,
  PUBLIC_RELATION_NAMES_V4,
  readPublicWorkflowRows,
} from '@hub/contracts/public-data-model';
import {
  PUBLIC_FIELD_DEFINITIONS,
  PUBLIC_FIELD_DEFINITIONS_V4,
  publicDataDictionaryRows,
  publicDataDictionaryRowsV4,
} from './public-data-dictionary.js';

describe('public data dictionary', () => {
  it('covers every public relation with unique, derivation-aware field metadata', () => {
    const keys = PUBLIC_FIELD_DEFINITIONS.map(({ relation, field }) => `${relation}.${field}`);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(PUBLIC_FIELD_DEFINITIONS.map((definition) => definition.relation))).toEqual(
      new Set(PUBLIC_RELATION_NAMES),
    );
    expect(PUBLIC_FIELD_DEFINITIONS.every((definition) => definition.derivation.length > 0)).toBe(true);
    expect(PUBLIC_FIELD_DEFINITIONS.every((definition) => definition.privacyRule.length > 0)).toBe(true);
  });

  it('serializes stable documentation rows without raw workflow bodies', () => {
    const rows = publicDataDictionaryRows();

    expect(rows.find((row) => row.relation === 'workflows' && row.field === 'body')).toMatchObject({
      nullable: true,
      rightsClass: 'all; always null in public-data-model-v3',
      privacyRule: 'never inline workflow JSON',
    });
    expect(rows.some((row) => row.field === 'nodes' || row.field === 'connections')).toBe(false);
    expect(rows).toEqual(PUBLIC_FIELD_DEFINITIONS);
    expect(new Set(rows.map(({ relation }) => relation))).toEqual(new Set(PUBLIC_RELATION_NAMES));
  });
});

const COVERAGE_FIELDS = [
  'coverageId', 'workflowId', 'sourceId', 'evidenceSchema', 'inventorySha256', 'sourceBodySha256',
  'bodyStatus', 'coverageState', 'omissionCodes', 'omissionCounts', 'source', 'sourcePointer',
  'repository', 'commit', 'licence', 'verification',
] as const;
const EVIDENCE_FIELDS = [
  'evidenceId', 'coverageId', 'workflowId', 'category', 'observation', 'requirement', 'source',
  'nodeIndex', 'observationOrdinal', 'nodePointer', 'pointerScope', 'detailPointer', 'nodeName',
  'nodeType', 'typeVersion', 'publicLabel', 'credentialReference', 'subworkflowResolution',
  'environmentNamespace', 'installation', 'credentialValidity', 'runtimeAvailability', 'ownership',
  'omissionCodes',
] as const;

describe('public data model v4 dictionary', () => {
  const v4Field = (relation: 'preflightCoverage' | 'preflightEvidence', field: string) =>
    publicDataDictionaryRowsV4().find((row) => row.relation === relation && row.field === field);

  it('keeps the original 16 relations and appends exactly 18 in frozen order', () => {
    expect(publicDataDictionaryRows()).toHaveLength(PUBLIC_FIELD_DEFINITIONS.length);
    expect(new Set(publicDataDictionaryRows().map(({ relation }) => relation))).toEqual(new Set(PUBLIC_RELATION_NAMES));
    expect([...new Set(publicDataDictionaryRowsV4().map(({ relation }) => relation))]).toEqual([...PUBLIC_RELATION_NAMES_V4]);
    expect(PUBLIC_RELATION_NAMES_V4).toEqual([...PUBLIC_RELATION_NAMES, 'preflightCoverage', 'preflightEvidence']);
  });

  it('documents the exact non-duplicated C1b coverage and evidence allowlists', () => {
    expect(publicDataDictionaryRowsV4().filter(({ relation }) => relation === 'preflightCoverage').map(({ field }) => field)).toEqual([...COVERAGE_FIELDS]);
    expect(publicDataDictionaryRowsV4().filter(({ relation }) => relation === 'preflightEvidence').map(({ field }) => field)).toEqual([...EVIDENCE_FIELDS]);
    const keys = PUBLIC_FIELD_DEFINITIONS_V4.map(({ relation, field }) => relation + '.' + field);
    expect(new Set(keys).size).toBe(keys.length);
    expect(PUBLIC_FIELD_DEFINITIONS_V4.every(({ derivation, privacyRule }) => derivation.length > 0 && privacyRule.length > 0)).toBe(true);
  });

  it('uses exact v4 release and artifact enums and the v4 body rule', () => {
    const releaseSchema = PUBLIC_FIELD_DEFINITIONS_V4.find((row) => row.relation === 'releases' && row.field === 'schemaVersion');
    const artifactRelation = PUBLIC_FIELD_DEFINITIONS_V4.find((row) => row.relation === 'artifacts' && row.field === 'relation');

    expect(releaseSchema?.type).toBe('enum: ' + PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
    expect(artifactRelation?.type).toBe('enum: ' + PUBLIC_RELATION_NAMES_V4.join(' | '));
    expect(PUBLIC_FIELD_DEFINITIONS_V4.find((row) => row.relation === 'workflows' && row.field === 'body')?.rightsClass)
      .toBe('all; always null in public-data-model-v4');
  });

  it('documents the C1b category, scope and null-detail matrix without leaking values', () => {
    const matrix = ['category', 'pointerScope', 'detailPointer'].map((field) => v4Field('preflightEvidence', field)?.derivation).join(' ');
    const credentialReference = v4Field('preflightEvidence', 'credentialReference');

    expect(matrix).toContain('credential -> CONTAINER /nodes/<i>/credentials');
    expect(matrix).toContain('community-node -> NODE /nodes/<i>');
    expect(matrix).toContain('integration -> NODE /nodes/<i>');
    expect(matrix).toContain('subworkflow -> FIELD /nodes/<i>/parameters/workflowId');
    expect(matrix).toContain('NODE /nodes/<i> with ABSENT and unresolved observation');
    expect(matrix).toContain('environment -> FIELD safe /nodes/<i>/parameters/...');
    expect(v4Field('preflightEvidence', 'observationOrdinal')?.derivation).toContain('observed ordinal 0');
    expect(v4Field('preflightEvidence', 'requirement')).toMatchObject({ type: 'literal: unknown', nullable: false });
    expect(v4Field('preflightEvidence', 'nodeName')).toMatchObject({ type: 'null', nullable: false });
    expect(credentialReference).toMatchObject({ type: 'null', nullable: false });
    expect(credentialReference?.privacyRule).toContain('never a credential key, value, id or name');
    expect(v4Field('preflightCoverage', 'source')).toMatchObject({ type: 'enum: WORKFLOW_EXPORT', nullable: false });
    expect(v4Field('preflightCoverage', 'sourceBodySha256')?.nullable).toBe(true);
    expect(v4Field('preflightEvidence', 'nodeType')?.nullable).toBe(true);
    expect(v4Field('preflightEvidence', 'typeVersion')?.nullable).toBe(true);
    expect(v4Field('preflightEvidence', 'subworkflowResolution')?.nullable).toBe(true);
    expect(v4Field('preflightEvidence', 'environmentNamespace')?.nullable).toBe(true);
  });

  it('corrects the v4 NO_RESULT derivation and returns cloned rows', () => {
    const freshness = PUBLIC_FIELD_DEFINITIONS_V4.find((row) => row.relation === 'workflows' && row.field === 'scanEvidence.scanFreshness');
    const first = publicDataDictionaryRowsV4();

    expect(freshness?.derivation).toContain('requires a bound body digest');
    expect(freshness?.derivation).not.toContain('no digest');
    first[0]!.field = 'mutated';
    expect(publicDataDictionaryRowsV4()[0]?.field).toBe('releaseId');
  });
});

/** The four per-row provenance fields `public-data-model-v2` adds, in the dictionary's own style. */
const SCAN_EVIDENCE_FIELDS = ['scannerVersion', 'analysisStatus', 'scanFreshness', 'scanBodySha256'] as const;

describe('public data model v2 scan evidence', () => {
  const field = (name: (typeof SCAN_EVIDENCE_FIELDS)[number]) =>
    publicDataDictionaryRows().find((row) => row.relation === 'workflows' && row.field === `scanEvidence.${name}`);

  it('documents all four new fields with enum values, null semantics, authority and privacy', () => {
    for (const name of SCAN_EVIDENCE_FIELDS) {
      expect(field(name)).toEqual(expect.objectContaining({ relation: 'workflows', authority: 'deterministic', rightsClass: 'all' }));
      expect(field(name)?.derivation.length).toBeGreaterThan(0);
      expect(field(name)?.privacyRule.length).toBeGreaterThan(0);
    }
    expect(field('scanFreshness')).toMatchObject({ type: 'enum: CURRENT | NO_RESULT | HISTORICAL | UNSCANNED | SOURCE_UNAVAILABLE', nullable: false });
    expect(field('analysisStatus')).toMatchObject({ type: 'enum: COMPLETE | DEGRADED | INDETERMINATE, or null', nullable: true });
    expect(field('scannerVersion')).toMatchObject({ type: 'string or null', nullable: true });
    expect(field('scannerVersion')?.derivation).toContain('release identity only');
    expect(field('scanBodySha256')).toMatchObject({ type: 'lowercase SHA-256 or null', nullable: true });
    expect(field('scanBodySha256')?.privacyRule).toContain('never the public pack hash');
  });

  it('says rights and scan freshness answer different questions', () => {
    expect(field('scanFreshness')?.derivation).toContain('Independent of redistribution rights');
    expect(field('scanFreshness')?.derivation).toContain('different question');
  });

  it('keeps the release-level scannerVersion release identity only', () => {
    const releaseField = publicDataDictionaryRows().find((row) => row.relation === 'releases' && row.field === 'scannerVersion');

    expect(releaseField?.privacyRule).toContain('release identity only');
    expect(releaseField?.privacyRule).toContain('never a producing engine');
  });
});

const V1_ROW = {
  workflowId: 'workflow-1',
  grade: { status: 'known', value: 'HIGH' },
  score: { status: 'known', value: 40 },
  readinessStatus: 'known',
};

describe('public release documents are read at the version they declare', () => {
  it('reads a public-data-model-v1 document unchanged and invents no scan evidence for it', () => {
    const reading = readPublicWorkflowRows({ schemaVersion: 'public-data-model-v1', workflows: [V1_ROW] });

    expect(reading.schemaVersion).toBe('public-data-model-v1');
    expect(reading.workflows[0]).toEqual(V1_ROW);
    expect(Object.keys(reading.workflows[0] ?? {})).toEqual(Object.keys(V1_ROW));
  });

  it('reads a public-data-model-v2 row and returns its scan evidence', () => {
    const scanEvidence = {
      scannerVersion: '2.0.0',
      analysisStatus: 'COMPLETE',
      scanFreshness: 'CURRENT',
      scanBodySha256: 'e'.repeat(64),
    };
    const reading = readPublicWorkflowRows({
      schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2,
      workflows: [{ ...V1_ROW, scanEvidence }],
    });
    if (reading.schemaVersion !== PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2) throw new Error('expected a v2 reading');

    expect(reading.workflows[0]?.scanEvidence).toEqual(scanEvidence);
  });

  it('rejects a v2 row with no evidence and an unknown freshness value', () => {
    const document = (scanEvidence: unknown) => ({
      schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V2,
      workflows: [{ ...V1_ROW, scanEvidence }],
    });
    const unknownFreshness = { scannerVersion: null, analysisStatus: null, scanFreshness: 'FRESHISH', scanBodySha256: null };

    expect(() => readPublicWorkflowRows(document(undefined))).toThrow(/scan evidence/);
    expect(() => readPublicWorkflowRows(document(unknownFreshness))).toThrow(/scan evidence/);
  });

  it('rejects an unknown schema version and v2 columns written under v1', () => {
    expect(() => readPublicWorkflowRows({ schemaVersion: 'public-data-model-v5', workflows: [] })).toThrow(/unsupported schema version/);
    const noResult = { scannerVersion: '2.0.0', analysisStatus: 'INDETERMINATE', scanFreshness: 'NO_RESULT', scanBodySha256: null };
    expect(() => readPublicWorkflowRows({ schemaVersion: 'public-data-model-v2', workflows: [{ ...V1_ROW, scanEvidence: noResult }] })).toThrow(/scan evidence/);
    expect(() => readPublicWorkflowRows({ schemaVersion: 'public-data-model-v1', workflows: [{ ...V1_ROW, scanEvidence: {} }] })).toThrow(/v1/);
  });
});
