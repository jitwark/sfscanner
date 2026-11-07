import { describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, PUBLIC_RELATION_NAMES } from './public-data-model';
import {
  comparePublicPreflightEvidenceRows,
  createPublicPreflightEvidenceId,
  isNonemptyCredentialContainer,
  readPublicPreflightCoverageRow,
  readPublicPreflightEvidenceRow,
  validatePublicPreflightRelations,
} from './public-preflight-data';
import {
  PUBLIC_PREFLIGHT_BODY_STATUSES,
  PUBLIC_PREFLIGHT_CATEGORY_LABELS,
  PUBLIC_PREFLIGHT_CATEGORY_ORDER,
  PUBLIC_PREFLIGHT_COVERAGE_STATES,
  PUBLIC_PREFLIGHT_NODE_TYPES,
  PUBLIC_PREFLIGHT_OMISSION_CODES,
  PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER,
  PUBLIC_PREFLIGHT_RELATION_NAMES,
  PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS,
  readPublicPreflightOmissionCodes,
  readPublicPreflightOmissionCounts,
} from './public-preflight-vocabulary';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const coverage = (overrides: Record<string, unknown> = {}) => ({
  coverageId: 'wf-001',
  workflowId: 'wf-001',
  sourceId: 'source-001',
  evidenceSchema: 'preflight-prerequisites-v1',
  inventorySha256: HASH_A,
  sourceBodySha256: HASH_B,
  bodyStatus: 'AVAILABLE',
  coverageState: 'COMPLETE',
  omissionCodes: [],
  omissionCounts: [],
  source: 'WORKFLOW_EXPORT',
  sourcePointer: '/',
  repository: 'UNKNOWN',
  commit: 'UNKNOWN',
  licence: 'UNKNOWN',
  verification: 'UNKNOWN',
  ...overrides,
});

type EvidenceInput = Readonly<{
  workflowId: string;
  category: string;
  pointerScope: string;
  detailPointer: string;
  nodeIndex: number;
  observationOrdinal: number;
  [key: string]: unknown;
}>;

const evidence = (overrides: EvidenceInput) => {
  const base = {
    coverageId: overrides.workflowId,
    observation: 'observed',
    requirement: 'unknown',
    source: 'WORKFLOW_EXPORT',
    nodePointer: `/nodes/${overrides.nodeIndex}`,
    nodeName: null,
    nodeType: 'n8n-nodes-base.httpRequest',
    typeVersion: '1.2',
    publicLabel: PUBLIC_PREFLIGHT_CATEGORY_LABELS[overrides.category as keyof typeof PUBLIC_PREFLIGHT_CATEGORY_LABELS],
    credentialReference: null,
    subworkflowResolution: null,
    environmentNamespace: null,
    installation: 'UNKNOWN',
    credentialValidity: 'UNKNOWN',
    runtimeAvailability: 'UNKNOWN',
    ownership: 'UNKNOWN',
    omissionCodes: ['NODE_NAME_WITHHELD'],
    ...overrides,
  };
  const identity = {
    workflowId: base.workflowId,
    category: base.category as 'credential' | 'community-node' | 'integration' | 'subworkflow' | 'environment',
    pointerScope: base.pointerScope as 'NODE' | 'FIELD' | 'CONTAINER',
    detailPointer: base.detailPointer,
    nodeIndex: base.nodeIndex,
    observationOrdinal: base.observationOrdinal,
  };
  return { evidenceId: createPublicPreflightEvidenceId(identity), ...base };
};

const credentialEvidence = (overrides: Partial<EvidenceInput> = {}) => evidence({
  workflowId: 'wf-001', category: 'credential', pointerScope: 'CONTAINER',
  detailPointer: '/nodes/2/credentials', nodeIndex: 2, observationOrdinal: 0,
  omissionCodes: ['NODE_NAME_WITHHELD', 'CREDENTIAL_POINTER_WITHHELD'], ...overrides,
});

const partialCoverage = (overrides: Record<string, unknown> = {}) => coverage({
  coverageState: 'PARTIAL',
  omissionCodes: ['NODE_NAME_WITHHELD', 'CREDENTIAL_POINTER_WITHHELD'],
  omissionCounts: [
    { code: 'NODE_NAME_WITHHELD', count: 1, basis: 'EXACT' },
    { code: 'CREDENTIAL_POINTER_WITHHELD', count: 1, basis: 'EXACT' },
  ],
  ...overrides,
});

describe('public preflight vocabulary', () => {
  it('freezes the exact catalogs, labels, node allowlist and safe keys', () => {
    expect(PUBLIC_PREFLIGHT_RELATION_NAMES).toEqual(['preflightCoverage', 'preflightEvidence']);
    expect(PUBLIC_PREFLIGHT_OMISSION_CODES).toEqual([
      'BODY_MISSING', 'BODY_SOURCE_UNAVAILABLE', 'BODY_UNPARSEABLE', 'BODY_REJECTED',
      'BODY_BINDING_UNKNOWN', 'COLLECTOR_REJECTED', 'COLLECTOR_LIMIT', 'COMPUTED_ACCESS',
      'UNSAFE_PARAMETER_PATH', 'NODE_NAME_WITHHELD', 'IDENTIFIER_WITHHELD',
      'CREDENTIAL_POINTER_WITHHELD', 'SUBWORKFLOW_ID_WITHHELD', 'INVALID_EXPORT_EVIDENCE',
    ]);
    expect(PUBLIC_PREFLIGHT_CATEGORY_ORDER).toEqual(['credential', 'community-node', 'integration', 'subworkflow', 'environment']);
    expect(PUBLIC_PREFLIGHT_CATEGORY_LABELS).toEqual({
      credential: 'Credential references at node',
      'community-node': 'Community package reference',
      integration: 'Integration observation',
      subworkflow: 'Subworkflow reference',
      environment: 'Environment reference',
    });
    expect(PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER).toEqual(['NODE', 'FIELD', 'CONTAINER']);
    expect(PUBLIC_PREFLIGHT_BODY_STATUSES).toEqual(['AVAILABLE', 'MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED']);
    expect(PUBLIC_PREFLIGHT_COVERAGE_STATES).toEqual(['COMPLETE', 'PARTIAL', 'UNKNOWN']);
    expect(PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS).toEqual(['url', 'options', 'headers', 'list', 'jsCode', 'text', 'value', 'jsonBody']);
    expect(PUBLIC_PREFLIGHT_NODE_TYPES).toEqual([
      'n8n-nodes-base.set', 'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.switch',
      'n8n-nodes-base.filter', 'n8n-nodes-base.merge', 'n8n-nodes-base.splitInBatches',
      'n8n-nodes-base.splitOut', 'n8n-nodes-base.aggregate', 'n8n-nodes-base.itemLists',
      'n8n-nodes-base.sort', 'n8n-nodes-base.limit', 'n8n-nodes-base.removeDuplicates',
      'n8n-nodes-base.wait', 'n8n-nodes-base.noOp', 'n8n-nodes-base.start',
      'n8n-nodes-base.stickyNote', 'n8n-nodes-base.dateTime', 'n8n-nodes-base.compareDatasets',
      'n8n-nodes-base.stopAndError', 'n8n-nodes-base.respondToWebhook', 'n8n-nodes-base.webhook',
      'n8n-nodes-base.formTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger',
      'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.crypto',
      'n8n-nodes-base.httpRequest', 'n8n-nodes-base.graphql', 'n8n-nodes-base.slack',
      'n8n-nodes-base.gmail', 'n8n-nodes-base.postgres', 'n8n-nodes-base.executeWorkflow',
    ]);
    expect(PUBLIC_PREFLIGHT_NODE_TYPES).toHaveLength(34);
    for (const catalog of [
      PUBLIC_PREFLIGHT_RELATION_NAMES, PUBLIC_PREFLIGHT_OMISSION_CODES, PUBLIC_PREFLIGHT_CATEGORY_ORDER,
      PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER, PUBLIC_PREFLIGHT_BODY_STATUSES, PUBLIC_PREFLIGHT_COVERAGE_STATES,
      PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS, PUBLIC_PREFLIGHT_NODE_TYPES,
    ]) expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(PUBLIC_PREFLIGHT_CATEGORY_LABELS)).toBe(true);
    expect(PUBLIC_DATA_MODEL_SCHEMA_VERSION).toBe('public-data-model-v3');
    expect(PUBLIC_RELATION_NAMES).toHaveLength(16);
    expect(PUBLIC_RELATION_NAMES).not.toContain('preflightCoverage');
    expect(PUBLIC_RELATION_NAMES).not.toContain('preflightEvidence');
  });

  it('accepts canonical omission subsets and rejects reordered or widened records', () => {
    const codes = ['NODE_NAME_WITHHELD', 'IDENTIFIER_WITHHELD'];
    const counts = [
      { code: 'NODE_NAME_WITHHELD', count: 2, basis: 'EXACT' },
      { code: 'IDENTIFIER_WITHHELD', count: 1, basis: 'LOWER_BOUND' },
    ];
    const readCodes = readPublicPreflightOmissionCodes(codes);
    const readCounts = readPublicPreflightOmissionCounts(counts);
    expect(readCodes).toEqual(codes);
    expect(readCounts).toEqual(counts);
    expect(Object.isFrozen(readCodes)).toBe(true);
    expect(Object.isFrozen(readCounts)).toBe(true);
    expect(readCounts?.every(Object.isFrozen)).toBe(true);
    expect(readPublicPreflightOmissionCodes([...codes].reverse())).toBeUndefined();
    expect(readPublicPreflightOmissionCodes([codes[0], codes[0]])).toBeUndefined();
    expect(readPublicPreflightOmissionCounts([...counts].reverse())).toBeUndefined();
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(readPublicPreflightOmissionCounts([{ ...counts[0], count }])).toBeUndefined();
    }
    expect(readPublicPreflightOmissionCounts([{ ...counts[0], extra: true }])).toBeUndefined();
  });
});

describe('public preflight coverage', () => {
  it('enforces every body status and source-body hash nullability pair', () => {
    const cases = [
      ['AVAILABLE', HASH_A, 'COMPLETE', [], []],
      ['MISSING', null, 'UNKNOWN', ['BODY_MISSING'], [{ code: 'BODY_MISSING', count: 1, basis: 'EXACT' }]],
      ['SOURCE_UNAVAILABLE', null, 'UNKNOWN', ['BODY_SOURCE_UNAVAILABLE'], [{ code: 'BODY_SOURCE_UNAVAILABLE', count: 1, basis: 'EXACT' }]],
      ['UNPARSEABLE', HASH_A, 'UNKNOWN', ['BODY_UNPARSEABLE'], [{ code: 'BODY_UNPARSEABLE', count: 1, basis: 'EXACT' }]],
      ['REJECTED', HASH_A, 'UNKNOWN', ['BODY_REJECTED'], [{ code: 'BODY_REJECTED', count: 1, basis: 'EXACT' }]],
      ['REJECTED', null, 'UNKNOWN', ['BODY_REJECTED'], [{ code: 'BODY_REJECTED', count: 1, basis: 'EXACT' }]],
    ] as const;
    for (const [bodyStatus, sourceBodySha256, coverageState, omissionCodes, omissionCounts] of cases) {
      expect(readPublicPreflightCoverageRow(coverage({ bodyStatus, sourceBodySha256, coverageState, omissionCodes, omissionCounts }))).toBeDefined();
    }
    expect(readPublicPreflightCoverageRow(coverage({ bodyStatus: 'UNKNOWN' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ bodyStatus: 'MISSING' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ bodyStatus: 'SOURCE_UNAVAILABLE', sourceBodySha256: null, coverageState: 'UNKNOWN', omissionCodes: ['BODY_MISSING'], omissionCounts: [{ code: 'BODY_MISSING', count: 1, basis: 'EXACT' }] }))).toBeUndefined();
  });

  it('enforces state, exact-field, canonical omission and literal provenance rules', () => {
    const row = readPublicPreflightCoverageRow(coverage());
    expect(row && Object.keys(row)).toHaveLength(16);
    expect(row && Object.isFrozen(row)).toBe(true);
    expect(row).toMatchObject({ source: 'WORKFLOW_EXPORT', sourcePointer: '/', repository: 'UNKNOWN', commit: 'UNKNOWN', licence: 'UNKNOWN', verification: 'UNKNOWN' });
    expect(readPublicPreflightCoverageRow(coverage({ coverageState: 'PARTIAL' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ coverageState: 'UNKNOWN' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(partialCoverage())).toBeDefined();
    expect(readPublicPreflightCoverageRow(partialCoverage({ omissionCodes: ['CREDENTIAL_POINTER_WITHHELD', 'NODE_NAME_WITHHELD'], omissionCounts: [...partialCoverage().omissionCounts].reverse() }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(partialCoverage({ omissionCounts: [partialCoverage().omissionCounts[0]] }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ coverageId: 'wf-other' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ repository: 'guessed' }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow(coverage({ inventorySha256: 'A'.repeat(64) }))).toBeUndefined();
    expect(readPublicPreflightCoverageRow({ ...coverage(), credentialKey: 'canary' })).toBeUndefined();
  });
});

describe('public preflight evidence', () => {
  it('covers every category scope pointer label and environment safe-key cell', () => {
    const rows = [
      credentialEvidence(),
      evidence({ workflowId: 'wf-001', category: 'community-node', pointerScope: 'NODE', detailPointer: '/nodes/0', nodeIndex: 0, observationOrdinal: 0 }),
      evidence({ workflowId: 'wf-001', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/1', nodeIndex: 1, observationOrdinal: 0 }),
      evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'FIELD', detailPointer: '/nodes/2/parameters/workflowId', nodeIndex: 2, observationOrdinal: 0, subworkflowResolution: 'LITERAL' }),
      evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'FIELD', detailPointer: '/nodes/3/parameters/workflowId', nodeIndex: 3, observationOrdinal: 0, subworkflowResolution: 'DYNAMIC', observation: 'unresolved' }),
      evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'NODE', detailPointer: '/nodes/4', nodeIndex: 4, observationOrdinal: 0, subworkflowResolution: 'ABSENT', observation: 'unresolved' }),
    ];
    for (const key of PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS) {
      rows.push(evidence({ workflowId: 'wf-001', category: 'environment', pointerScope: 'FIELD', detailPointer: `/nodes/5/parameters/${key}`, nodeIndex: 5, observationOrdinal: 0, environmentNamespace: 'ENV' }));
    }
    rows.push(evidence({ workflowId: 'wf-001', category: 'environment', pointerScope: 'FIELD', detailPointer: '/nodes/6/parameters/headers/0/value', nodeIndex: 6, observationOrdinal: 0, environmentNamespace: 'VARS' }));
    for (const row of rows) expect(readPublicPreflightEvidenceRow(row)).toBeDefined();
    expect(readPublicPreflightEvidenceRow(evidence({ workflowId: 'wf-001', category: 'integration', pointerScope: 'FIELD', detailPointer: '/nodes/1', nodeIndex: 1, observationOrdinal: 0 }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(evidence({ workflowId: 'wf-001', category: 'environment', pointerScope: 'FIELD', detailPointer: '/nodes/5/parameters/00', nodeIndex: 5, observationOrdinal: 0, environmentNamespace: 'ENV' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(evidence({ workflowId: 'wf-001', category: 'environment', pointerScope: 'FIELD', detailPointer: '/nodes/5/parameters/constructor', nodeIndex: 5, observationOrdinal: 0, environmentNamespace: 'ENV' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(evidence({ workflowId: 'wf-001', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/1', nodeIndex: 1, observationOrdinal: 0, publicLabel: 'Free-form label' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'NODE', detailPointer: '/nodes/1', nodeIndex: 1, observationOrdinal: 0, subworkflowResolution: 'LITERAL' }))).toBeUndefined();
  });

  it('validates decimal type versions without inferring a default', () => {
    for (const value of ['0', '12', '1.2', '1.2.3', 0, 1.25, null]) expect(readPublicPreflightEvidenceRow(credentialEvidence({ typeVersion: value }))).toBeDefined();
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ typeVersion: 12.5 }))?.typeVersion).toBe('12.5');
    for (const value of ['', '01', '1e2', '1.2.3.4', ' 1', '1.2x', '1'.repeat(33), -1, Infinity, NaN]) {
      expect(readPublicPreflightEvidenceRow(credentialEvidence({ typeVersion: value }))).toBeUndefined();
    }
  });

  it('models one value-free credential container observation', () => {
    const row = readPublicPreflightEvidenceRow(credentialEvidence());
    expect(row).toMatchObject({ observation: 'observed', observationOrdinal: 0, nodeName: null, credentialReference: null, installation: 'UNKNOWN', credentialValidity: 'UNKNOWN', runtimeAvailability: 'UNKNOWN', ownership: 'UNKNOWN' });
    expect(isNonemptyCredentialContainer({ syntheticKey: { id: 'not-read' } })).toBe(true);
    for (const value of [null, {}, [], 'value', 1, false]) expect(isNonemptyCredentialContainer(value)).toBe(false);
    expect(isNonemptyCredentialContainer(Object.defineProperty({}, Symbol('hidden'), { value: true, enumerable: true }))).toBe(false);
    let reads = 0;
    const getterOnly = Object.defineProperty({ key: true }, 'key', { enumerable: true, get: () => { reads += 1; return 'secret'; } });
    expect(isNonemptyCredentialContainer(getterOnly)).toBe(true);
    expect(reads).toBe(0);
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ nodeName: 'private node' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ credentialReference: 'ID_AND_NAME' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ detailPointer: '/nodes/2/credentials/key' }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ omissionCodes: ['NODE_NAME_WITHHELD'] }))).toBeUndefined();
    expect(readPublicPreflightEvidenceRow({ ...credentialEvidence(), credentialKey: 'canary' })).toBeUndefined();
    for (const key of ['installation', 'credentialValidity', 'runtimeAvailability', 'ownership']) expect(readPublicPreflightEvidenceRow(credentialEvidence({ [key]: 'known' }))).toBeUndefined();
  });

  it('derives the exact value-free identity and deterministic comparator order', () => {
    const known = createPublicPreflightEvidenceId({ workflowId: 'wf-001', category: 'credential', pointerScope: 'CONTAINER', detailPointer: '/nodes/2/credentials', nodeIndex: 2, observationOrdinal: 0 });
    expect(known).toBe('7b9a35389e9bea7bac91717546ba1fab91ee14f126b67ac7d91d8641928d4b24');
    expect(credentialEvidence().evidenceId).toBe(known);
    const extra = createPublicPreflightEvidenceId({ workflowId: 'wf-001', category: 'credential', pointerScope: 'CONTAINER', detailPointer: '/nodes/2/credentials', nodeIndex: 2, observationOrdinal: 0, nodeName: 'private' } as never);
    expect(extra).toBe(known);
    expect(readPublicPreflightEvidenceRow(credentialEvidence({ evidenceId: 'f'.repeat(64) }))).toBeUndefined();
    const unicodeLeft = evidence({ workflowId: '\uE000', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/0', nodeIndex: 0, observationOrdinal: 0 });
    const unicodeRight = evidence({ workflowId: '\u{10000}', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/0', nodeIndex: 0, observationOrdinal: 0 });
    expect(comparePublicPreflightEvidenceRows(unicodeLeft as never, unicodeRight as never)).toBeLessThan(0);
    const credential = credentialEvidence();
    const integration = evidence({ workflowId: 'wf-001', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/0', nodeIndex: 0, observationOrdinal: 0 });
    expect(comparePublicPreflightEvidenceRows(credential as never, integration as never)).toBeLessThan(0);
    const absent = evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'NODE', detailPointer: '/nodes/1', nodeIndex: 1, observationOrdinal: 0, subworkflowResolution: 'ABSENT' });
    const present = evidence({ workflowId: 'wf-001', category: 'subworkflow', pointerScope: 'FIELD', detailPointer: '/nodes/1/parameters/workflowId', nodeIndex: 1, observationOrdinal: 0, subworkflowResolution: 'LITERAL' });
    expect(comparePublicPreflightEvidenceRows(absent as never, present as never)).toBeLessThan(0);
  });
});

describe('C1b conformance repair', () => {
  const classifications = [
    ['AVAILABLE', null, HASH_A],
    ['MISSING', 'BODY_MISSING', null],
    ['SOURCE_UNAVAILABLE', 'BODY_SOURCE_UNAVAILABLE', null],
    ['UNPARSEABLE', 'BODY_UNPARSEABLE', HASH_A],
    ['REJECTED', 'BODY_REJECTED', HASH_A],
  ] as const;
  for (const [status, matching, sourceBodySha256] of classifications) {
    for (const code of ['BODY_MISSING', 'BODY_SOURCE_UNAVAILABLE', 'BODY_UNPARSEABLE', 'BODY_REJECTED'] as const) {
      if (code === matching) continue;
      it(`rejects ${status} with contradictory ${code}`, () => {
        const codes = PUBLIC_PREFLIGHT_OMISSION_CODES.filter((item) => item === matching || item === code);
        expect(readPublicPreflightCoverageRow(coverage({ bodyStatus: status, sourceBodySha256,
          coverageState: 'UNKNOWN', omissionCodes: codes,
          omissionCounts: codes.map((item) => ({ code: item, count: 1, basis: 'EXACT' })),
        }))).toBeUndefined();
      });
    }
    it(`preserves ${status} with unrelated binding and collection omissions`, () => {
      const codes = PUBLIC_PREFLIGHT_OMISSION_CODES.filter((item) => item === matching
        || item === 'BODY_BINDING_UNKNOWN' || item === 'COLLECTOR_LIMIT');
      expect(readPublicPreflightCoverageRow(coverage({ bodyStatus: status, sourceBodySha256,
        coverageState: 'UNKNOWN', omissionCodes: codes,
        omissionCounts: codes.map((code) => ({ code, count: 1, basis: 'LOWER_BOUND' })),
      }))).toBeDefined();
    });
  }

  for (const resolution of ['DYNAMIC', 'ABSENT', null] as const) {
    for (const observation of ['observed', 'inferred', 'unresolved'] as const) {
      it(`${String(resolution)} subworkflow ${observation} follows unresolved semantics`, () => {
        const row = evidence({ workflowId: 'wf-001', category: 'subworkflow',
          pointerScope: resolution === 'ABSENT' ? 'NODE' : 'FIELD',
          detailPointer: resolution === 'ABSENT' ? '/nodes/2' : '/nodes/2/parameters/workflowId',
          nodeIndex: 2, observationOrdinal: 0, subworkflowResolution: resolution, observation });
        if (observation === 'unresolved') expect(readPublicPreflightEvidenceRow(row)).toBeDefined();
        else expect(readPublicPreflightEvidenceRow(row)).toBeUndefined();
      });
    }
  }

  it('preserves literal and bounded inferred classifications without widening absent anchors', () => {
    for (const category of ['subworkflow', 'integration', 'community-node', 'environment'] as const) {
      for (const observation of ['observed', 'inferred'] as const) {
        const row = evidence({ workflowId: 'wf-001', category, observation, nodeIndex: 2, observationOrdinal: 0,
          pointerScope: category === 'subworkflow' || category === 'environment' ? 'FIELD' : 'NODE',
          detailPointer: category === 'subworkflow' ? '/nodes/2/parameters/workflowId'
            : category === 'environment' ? '/nodes/2/parameters/text' : '/nodes/2',
          subworkflowResolution: category === 'subworkflow' ? 'LITERAL' : null,
          environmentNamespace: category === 'environment' ? 'ENV' : null });
        expect(readPublicPreflightEvidenceRow(row)).toBeDefined();
      }
    }
    for (const resolution of ['ABSENT', null] as const) {
      const row = evidence({ workflowId: 'wf-001', category: 'subworkflow', observation: 'unresolved',
        nodeIndex: 2, observationOrdinal: 0, pointerScope: resolution === 'ABSENT' ? 'FIELD' : 'NODE',
        detailPointer: resolution === 'ABSENT' ? '/nodes/2/parameters/workflowId' : '/nodes/2',
        subworkflowResolution: resolution });
      expect(readPublicPreflightEvidenceRow(row)).toBeUndefined();
    }
  });
});

describe('public preflight relations', () => {
  it('accepts exact sorted relations and rejects foreign, duplicate, unordered and incomplete rows', () => {
    const evidenceRow = credentialEvidence();
    expect(validatePublicPreflightRelations([partialCoverage()], [evidenceRow])).toBe(true);
    expect(validatePublicPreflightRelations([partialCoverage()], [{ ...evidenceRow, coverageId: 'wf-other', workflowId: 'wf-other' }])).toBe(false);
    expect(validatePublicPreflightRelations([partialCoverage(), partialCoverage()], [evidenceRow])).toBe(false);
    expect(validatePublicPreflightRelations([partialCoverage()], [evidenceRow, evidenceRow])).toBe(false);
    expect(validatePublicPreflightRelations([partialCoverage()], [evidenceRow, credentialEvidence({ nodeIndex: 3, detailPointer: '/nodes/3/credentials' })])).toBe(false);
    const integration = evidence({ workflowId: 'wf-001', category: 'integration', pointerScope: 'NODE', detailPointer: '/nodes/0', nodeIndex: 0, observationOrdinal: 0 });
    expect(validatePublicPreflightRelations([partialCoverage()], [integration as never, evidenceRow])).toBe(false);
    expect(validatePublicPreflightRelations([partialCoverage({ coverageState: 'COMPLETE', omissionCodes: [], omissionCounts: [] })], [evidenceRow])).toBe(false);
  });

  it('sorts coverage by UTF-8 workflow bytes and aggregates evidence omission counts', () => {
    const missing = coverage({ coverageId: '\u{10000}', workflowId: '\u{10000}', sourceId: 'source-b' });
    const earlier = coverage({ coverageId: '\uE000', workflowId: '\uE000', sourceId: 'source-a' });
    expect(validatePublicPreflightRelations([missing, earlier], [])).toBe(false);
    expect(validatePublicPreflightRelations([earlier, missing], [])).toBe(true);
    const twoCredentials = [credentialEvidence(), credentialEvidence({ nodeIndex: 3, detailPointer: '/nodes/3/credentials' })];
    expect(validatePublicPreflightRelations([partialCoverage()], twoCredentials)).toBe(false);
    const countTwo = partialCoverage({ omissionCounts: [
      { code: 'NODE_NAME_WITHHELD', count: 2, basis: 'EXACT' },
      { code: 'CREDENTIAL_POINTER_WITHHELD', count: 2, basis: 'EXACT' },
    ] });
    expect(validatePublicPreflightRelations([countTwo], twoCredentials)).toBe(true);
  });

  it('rejects accessors, symbols, extra members and malformed arrays without mutating callers', () => {
    const source = partialCoverage();
    const snapshot = JSON.stringify(source);
    const row = readPublicPreflightCoverageRow(source);
    expect(row).toBeDefined();
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row?.omissionCounts)).toBe(true);
    expect(Object.isFrozen(row?.omissionCounts[0])).toBe(true);
    const accessor = Object.defineProperties({}, Object.getOwnPropertyDescriptors(coverage()));
    Object.defineProperty(accessor, 'bodyStatus', { enumerable: true, get: () => 'AVAILABLE' });
    expect(readPublicPreflightCoverageRow(accessor)).toBeUndefined();
    const symbol = Object.defineProperty(coverage(), Symbol('foreign'), { value: true, enumerable: true });
    expect(readPublicPreflightCoverageRow(symbol)).toBeUndefined();
    const evidenceAccessor = Object.defineProperties({}, Object.getOwnPropertyDescriptors(credentialEvidence()));
    Object.defineProperty(evidenceAccessor, 'nodeName', { enumerable: true, get: () => null });
    expect(readPublicPreflightEvidenceRow(evidenceAccessor)).toBeUndefined();
    const evidenceSymbol = Object.defineProperty(credentialEvidence(), Symbol('foreign'), { value: true });
    expect(readPublicPreflightEvidenceRow(evidenceSymbol)).toBeUndefined();
    expect(validatePublicPreflightRelations({}, [])).toBe(false);
    expect(validatePublicPreflightRelations([], {})).toBe(false);
  });
});
