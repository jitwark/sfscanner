import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSemanticCatalogueDigest, admitSemanticCatalogue, SemanticCatalogueAdmissionError } from './catalogue-admission';
import { createSourceProvenanceBinding, type SourceReceipts } from './builtin-provenance';
import { resolveNodeSemantics } from './catalogue-resolver';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import type { ResolvedNodeSemanticsV2, SemanticCatalogueV2 } from './catalogue-schema';
import ingressFixture from './__fixtures__/ingress/reviewed-semantics.json';
import httpAiFixture from './__fixtures__/http-ai/reviewed-semantics.json';
import databaseFileFixture from './__fixtures__/database-file/reviewed-semantics.json';
import codeCommandFixture from './__fixtures__/code-command/reviewed-semantics.json';
import messageMcpFixture from './__fixtures__/message-mcp/reviewed-semantics.json';
import subworkflowFixture from './__fixtures__/subworkflow/reviewed-semantics.json';
import gitFixture from './__fixtures__/git/reviewed-semantics.json';

type ExpectedRecord = ResolvedNodeSemanticsV2;
type FixtureCase = {
  id: string;
  kind: 'POSITIVE' | 'NEGATIVE' | 'UNKNOWN';
  nodeType: string;
  version: string;
  operation: string | null;
  expectedSemanticId: string | null;
  expectedAuthenticationValue?: string;
  expectedAuthenticationEffect?: 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'EXPOSED';
  dynamicDestination?: string;
  expectedDestinationUncertainty?: 'KNOWN' | 'UNKNOWN';
  approvedDomains?: readonly string[];
};
type ReviewFixture = {
  schemaVersion: 'scanner-semantic-fixture-v2'; family: string;
  configuration: { allowNetwork: boolean; approvedDomains: readonly string[] };
  expectedRecords: Readonly<Record<string, ExpectedRecord>>; cases: readonly FixtureCase[];
};
const fixtures = [ingressFixture, httpAiFixture, databaseFileFixture, codeCommandFixture, messageMcpFixture, subworkflowFixture, gitFixture] as unknown as readonly ReviewFixture[];
const bodyOf = (catalogue: SemanticCatalogueV2) => { const { digest: _digest, ...body } = catalogue; return body; };
const deeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value); return Object.isFrozen(value) && Object.values(value).every((item) => deeplyFrozen(item, seen));
};

const CORE_DOC_URL = 'https://docs.n8n.io/integrations/builtin/core-nodes/';
const PLACEHOLDER_STEMS = ['7f4e2a9c', 'a1b2c3d4'];
const PRE_BINDING_CATALOGUE_DIGEST = '9cbb9fdafa87418b614569055904242cd8d278ca4880282f358b13eaf2ad8be7';
// Post-sticky-note digest: the CLI pins the same value in packages/scanner-cli/src/v2/contracts.ts and guards it with semantics-digest-parity.test.ts.
const NOOP_CATALOGUE_DIGEST = '58419339dcf99ed398d2955282662e6f6d37208f62393cafb56818d4a38182d7';
const FLOW_CONTROL_IDS = ['flow-control.set', 'flow-control.if', 'flow-control.switch', 'flow-control.merge', 'flow-control.split-in-batches', 'flow-control.schedule-trigger', 'google-workspace.google-sheets', 'message-mcp.gmail', 'flow-control.wait', 'message-mcp.telegram', 'transform.split-out', 'ai.output-parser-structured', 'annotation.sticky-note', 'google-workspace.google-drive', 'flow-control.filter', 'flow-control.aggregate'] as const;
const WEBHOOK_REFS = ['n8n-nodes-base@2.15.1:dist/a.js', 'n8n-nodes-base@2.15.1:dist/b.js'];
const committedReceipts = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/scanner/semantic-source-receipts.json', import.meta.url)), 'utf8')) as SourceReceipts;
const syntheticReceipts = (overrides: { documentsRecords?: Record<string, string[]>; aSha256?: string } = {}) => ({
  packages: [{ package: 'n8n-nodes-base', version: '2.15.1', fetchedAt: '2026-10-17', files: [{ path: 'dist/a.js', sha256: overrides.aSha256 ?? 'a'.repeat(64) }, { path: 'dist/b.js', sha256: 'b'.repeat(64) }] }],
  documentsRecords: overrides.documentsRecords ?? { 'ingress.webhook': [...WEBHOOK_REFS], 'http-ai.ai-agent': ['n8n-nodes-base@2.15.1:dist/b.js'], 'subworkflow.execute-workflow': ['n8n-nodes-base@2.15.1:dist/a.js'] },
});
const boundProvenance = (receipts: SourceReceipts, semanticId = 'ingress.webhook') => createSourceProvenanceBinding(receipts)(semanticId, CORE_DOC_URL);
const admissionFailure = (run: () => unknown): SemanticCatalogueAdmissionError | null => { try { run(); return null; } catch (error) { return error as SemanticCatalogueAdmissionError; } };

describe('built-in semantic catalogue', () => {
  it('contains every reviewed family and only closed provenance-backed semantics', () => {
    const admitted = admitSemanticCatalogue(BUILTIN_SEMANTIC_CATALOGUE_V2);
    const expectedIds = new Set([...fixtures.flatMap(({ expectedRecords }) => Object.keys(expectedRecords)), ...FLOW_CONTROL_IDS, 'noop.passthrough']);
    expect(admitted.records.length).toBeGreaterThan(0);
    expect(new Set(admitted.records.map(({ semanticId }) => semanticId))).toEqual(expectedIds);
    for (const fixture of fixtures) {
      expect(fixture.schemaVersion).toBe('scanner-semantic-fixture-v2');
      expect(fixture.configuration).toEqual({ allowNetwork: false, approvedDomains: [] });
    }
    for (const record of admitted.records) {
      expect(record.provenance.sourceUrl).toMatch(/^https:\/\//);
      expect(record.provenance.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(record.provenance.reviewedAt).toBe('2026-10-17');
      expect(record.provenance.reviewer).toBe('scanner-core-semantics-agent-review');
      expect(record.effects).toEqual([...record.effects].sort());
      expect(record.endpoints.every((endpoint) => endpoint.path.startsWith('/'))).toBe(true);
      expect(record).not.toHaveProperty('severity');
      expect(record).not.toHaveProperty('score');
      expect(record).not.toHaveProperty('cve');
    }
  });

  it('resolves the reviewed LangChain code-executing node semantics', () => {
    const toolCode = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: '@n8n/n8n-nodes-langchain.toolCode',
      version: '1.3.0',
      operation: null,
    });
    expect(toolCode?.semanticId).toBe('code-command.langchain-tool-code');
    expect(toolCode?.effects).toEqual(['EXECUTE_CODE']);
    expect(toolCode?.parameterPaths.map(({ pointer }) => pointer).sort()).toEqual(['/jsCode', '/language', '/pythonCode']);
    expect(toolCode?.ports.map(({ type, itemMode }) => [type, itemMode])).toEqual([['ai_tool', 'ALL'], ['main', 'EACH']]);

    const langchainCode = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: '@n8n/n8n-nodes-langchain.code',
      version: '1.0.0',
      operation: null,
    });
    expect(langchainCode?.semanticId).toBe('code-command.langchain-code');
    expect(langchainCode?.effects).toEqual(['EXECUTE_CODE']);
    expect(langchainCode?.parameterPaths.map(({ pointer }) => pointer).sort()).toEqual(['/code/execute/code', '/code/supplyData/code']);
    expect(langchainCode?.ports).toEqual([]);
  });

  it('resolves the recorded noOp passthrough only at its exact pinned version', () => {
    const resolved = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.noOp', version: '1.0.0', operation: null });
    expect(resolved).toMatchObject({ semanticId: 'noop.passthrough', versionRange: { clauses: [[{ op: 'EQ', version: '1.0.0' }]] }, operation: null, entry: 'NONE', effects: [], parameterPaths: [], credentialPaths: [], destinationPaths: [], endpoints: [], overwritePaths: [], ports: [{ type: 'main', index: 0, itemMode: 'EACH' }], provenance: boundProvenance(committedReceipts, 'noop.passthrough') });
    expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.noOp', version: '2.0.0', operation: null })).toBeNull();
  });

  it('resolves the reviewed Git family operations and fallback', () => {
    const git = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.git',
      version: '1.0.0',
      operation: 'clone',
    });
    expect(git?.semanticId).toBe('git.git');
    expect(git?.effects).toEqual(['READ_EXTERNAL', 'WRITE_EXTERNAL']);
    expect(git?.destinationPaths).toEqual(['/repositoryUrl']);
  });

  it('resolves every positive, negative, and unknown family vector without inference', () => {
    let dynamicDestinationCases = 0;
    let unknownAuthenticationCases = 0;
    for (const fixture of fixtures) {
      for (const vector of fixture.cases) {
        const resolved = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
          nodeType: vector.nodeType,
          version: vector.version,
          operation: vector.operation,
        });
        expect(resolved?.semanticId ?? null, vector.id).toBe(vector.expectedSemanticId);
        if (vector.expectedSemanticId === null) {
          expect(resolved, vector.id).toBeNull();
          continue;
        }
        const expected = fixture.expectedRecords[vector.expectedSemanticId];
        expect(expected, vector.id).toBeDefined();
        expect(resolved, vector.id).toEqual(expected);
        expect(resolved?.operation, vector.id).toBe(expected.operation);
        if (vector.expectedAuthenticationValue !== undefined) {
          const authentication = resolved?.authentication;
          expect(authentication, vector.id).not.toBeNull();
          const value = vector.expectedAuthenticationValue;
          if (vector.expectedAuthenticationEffect === 'AUTHENTICATED') {
            expect(authentication?.authenticatedValues).toContain(value);
          } else if (vector.expectedAuthenticationEffect === 'UNAUTHENTICATED') {
            expect(authentication?.noneValues).toContain(value);
          } else {
            unknownAuthenticationCases += 1;
            expect(authentication?.unknownValueEffect).toBe('EXPOSED');
            expect(authentication?.noneValues).not.toContain(value);
            expect(authentication?.authenticatedValues).not.toContain(value);
          }
        }
        if (vector.dynamicDestination !== undefined) {
          dynamicDestinationCases += 1;
          expect(vector.expectedDestinationUncertainty).toBe('UNKNOWN');
          expect(vector.approvedDomains).toEqual([]);
          expect(expected.destinationPaths.length).toBeGreaterThan(0);
          expect(vector.dynamicDestination).not.toBe('');
        }
      }
    }
    expect(dynamicDestinationCases).toBeGreaterThan(0);
    expect(unknownAuthenticationCases).toBeGreaterThan(0);
  });

  it('covers operation precedence, defaults, and every semantic field', () => {
    const request = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '1.0.0',
      operation: 'request',
    });
    const fallback = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '2.0.0',
      operation: 'request',
    });
    expect(request?.semanticId).toBe('http-ai.http-request.request');
    expect(request?.operation).toBe('request');
    expect(fallback?.semanticId).toBe('http-ai.http-request');
    expect(fallback?.operation).toBeNull();
    for (const fixture of fixtures) {
      for (const expected of Object.values(fixture.expectedRecords)) {
        expect(expected.semanticId).toBeTruthy();
        expect(expected.nodeType).toBeTruthy();
        expect(expected.versionRange).toEqual(expect.any(Object));
        expect(expected.parameterPaths).toEqual(expect.any(Array));
        expect(expected.authentication === null || typeof expected.authentication === 'object').toBe(true);
        expect(expected.credentialPaths).toEqual(expect.any(Array));
        expect(expected.destinationPaths).toEqual(expect.any(Array));
        expect(expected.effects).toEqual(expect.any(Array));
        expect(expected.endpoints).toEqual(expect.any(Array));
        expect(expected.ports).toEqual(expect.any(Array));
        expect(expected.overwritePaths).toEqual(expect.any(Array));
        expect(['STOP', 'CONTINUE', 'OUTPUT', 'UNKNOWN']).toContain(expected.errorMode);
        expect(['NONE', 'BOUNDED', 'PLATFORM', 'UNKNOWN']).toContain(expected.retryMode);
        expect(['SKIP', 'UNKNOWN']).toContain(expected.disabledMode);
        expect(expected.provenance.sourceUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it('has a repeatable digest and deeply frozen output', () => {
    const body = bodyOf(BUILTIN_SEMANTIC_CATALOGUE_V2);
    expect(BUILTIN_SEMANTIC_CATALOGUE_V2.digest).toBe(createSemanticCatalogueDigest(body));
    expect(BUILTIN_SEMANTIC_CATALOGUE_V2.digest).toBe(NOOP_CATALOGUE_DIGEST);
    expect(createSemanticCatalogueDigest(body)).toBe(createSemanticCatalogueDigest(body));
    expect(deeplyFrozen(BUILTIN_SEMANTIC_CATALOGUE_V2)).toBe(true);
    expect(BUILTIN_SEMANTIC_CATALOGUE_V2.records.every(({ provenance }) => provenance.sourceUrl.startsWith('https://'))).toBe(true);
  });
});

describe('built-in catalogue provenance binding', () => {
  it('derives every record provenance from the committed receipt, never from a source literal', () => {
    const bound = createSourceProvenanceBinding(committedReceipts);
    for (const { semanticId, provenance } of BUILTIN_SEMANTIC_CATALOGUE_V2.records) expect(provenance, semanticId).toEqual(bound(semanticId, provenance.sourceUrl));
    expect(new Set(BUILTIN_SEMANTIC_CATALOGUE_V2.records.map(({ provenance }) => provenance.sourceDigest)).size).toBeGreaterThan(1);
    const sources = ['./builtin-catalogue.ts', './builtin-provenance.ts'].map((file) => [file, readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')] as const);
    for (const [file, source] of sources) for (const stem of PLACEHOLDER_STEMS) expect(source, `${file} carries ${stem}`).not.toContain(stem);
  });

  it('fails closed with the admission error when a record cannot be bound to receipt bytes', () => {
    const unusable: SourceReceipts[] = [syntheticReceipts({ documentsRecords: {} }), syntheticReceipts({ documentsRecords: { 'ingress.webhook': [] } }), syntheticReceipts({ documentsRecords: { 'ingress.webhook': ['n8n-nodes-base@2.15.1:dist/absent.js'] } }), syntheticReceipts({ aSha256: 'not-a-digest' })];
    for (const receipts of unusable) expect(admissionFailure(() => boundProvenance(receipts))?.code, JSON.stringify(receipts.documentsRecords)).toBe('INVALID_PROVENANCE');
    expect(admissionFailure(() => boundProvenance(unusable[0]))).toBeInstanceOf(SemanticCatalogueAdmissionError);
    expect(admissionFailure(() => boundProvenance(syntheticReceipts()))).toBeNull();
  });

  it('changes only the records bound to a changed receipt file', () => {
    const before = boundProvenance(syntheticReceipts());
    const changed = syntheticReceipts({ aSha256: 'd'.repeat(64) });
    expect(boundProvenance(changed).sourceDigest).not.toBe(before.sourceDigest);
    expect(boundProvenance(changed, 'http-ai.ai-agent')).toEqual(boundProvenance(syntheticReceipts(), 'http-ai.ai-agent'));
    expect(boundProvenance(changed, 'subworkflow.execute-workflow')).not.toEqual(boundProvenance(syntheticReceipts(), 'subworkflow.execute-workflow'));
  });

  it('pins the canonical construction and ignores receipt file order', () => {
    const pinned = createHash('sha256').update([`n8n-nodes-base@2.15.1:dist/a.js:${'a'.repeat(64)}`, `n8n-nodes-base@2.15.1:dist/b.js:${'b'.repeat(64)}`].join('\n'), 'utf8').digest('hex');
    const variant = (refs: string[]) => { const receipts = syntheticReceipts(); receipts.documentsRecords['ingress.webhook'] = refs; return boundProvenance(receipts).sourceDigest; };
    expect(variant(WEBHOOK_REFS)).toBe(pinned);
    expect(variant([...WEBHOOK_REFS].reverse())).toBe(pinned);
    expect(variant(WEBHOOK_REFS.slice(0, 1))).not.toBe(pinned);
  });

  it('keeps the admission contract while the catalogue digest moves off the placeholder', () => {
    expect(admitSemanticCatalogue(BUILTIN_SEMANTIC_CATALOGUE_V2).digest).not.toBe(PRE_BINDING_CATALOGUE_DIGEST);
  });
});
