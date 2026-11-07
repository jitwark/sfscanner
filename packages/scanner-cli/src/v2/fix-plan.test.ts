import { describe, expect, it } from 'vitest';
import {
  canonicalJsonSha256,
  endpointTargetIdentitySha256,
  readCredentialInventory,
} from '@hub/scanner-core/remediation/fix-preconditions';
import {
  createFixSuggestion,
  planFixSuggestion,
  type FixPrerequisiteEvidenceV1,
  type FixSuggestionFactV1,
  type PlanFixRequestV1,
} from '@hub/scanner-core/remediation/fix-suggestion';
import { parseSourceDocument } from '@hub/scanner-core/source/source-parser';
import { normalizeSecurityWorkflow } from '@hub/scanner-core/workflow-v2/normalize-security-workflow';
import type { InputReadHost } from './input-read';
import { runFixPlanV2, type FixPlanRequestV1 } from './fix-plan';
import { toFsPathV2 } from './path-admission';

const WORKFLOW = `{
  "name": "demo",
  "nodes": [
    {
      "id": "n1",
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": { "url": "http://insecure.example.com", "method": "GET" },
      "credentials": { "httpHeaderAuth": { "id": "cred-1", "name": "Header Auth" } }
    }
  ],
  "connections": {}
}`;

const ROOT = 'D:/fixplan-test';
const DIGEST = 'd'.repeat(64);
const COMPATIBILITY = 'c'.repeat(64);
const CURRENT_ENDPOINT = 'http://insecure.example.com';
const REPLACEMENT_ENDPOINT = 'https://api.example.com/v2';
const SHA = 'a'.repeat(64);

type Fixture = Readonly<{
  bytes: Uint8Array;
  sourceSha256: string;
  workflowDigest: string;
  nodeDigest: string;
  pointer: string;
}>;

function analyze(text = WORKFLOW): Fixture {
  const bytes = new TextEncoder().encode(text);
  const parsed = parseSourceDocument(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.code}`);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  if (!normalized.ok) throw new Error(`fixture normalize failed: ${normalized.code}`);
  const node = normalized.workflow.nodes[0];
  if (!node) throw new Error('fixture node missing');
  return {
    bytes,
    sourceSha256: parsed.document.rawSha256,
    workflowDigest: normalized.semanticSha256,
    nodeDigest: node.ref.identityDigest,
    pointer: `${node.ref.source.pointer}/parameters/url`,
  };
}

const fixture = analyze();

function suggestion(overrides: Record<string, unknown> = {}): FixSuggestionFactV1 {
  const created = createFixSuggestion({
    id: 'fix-1',
    findingIds: ['finding-1'],
    sourceSha256: fixture.sourceSha256,
    workflowDigest: fixture.workflowDigest,
    targetVersion: { packageName: 'n8n-nodes-base.httpRequest', version: '4.2.0', inventoryDigest: SHA },
    resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.nodeDigest, pointer: fixture.pointer },
    templateId: 'REMOVE_INSECURE_OVERRIDE',
    rationaleId: 'REMOVE_INSECURE_OVERRIDE',
    prerequisites: ['USER_CONFIRMATION'],
    ...overrides,
  });
  if (!created.ok) throw new Error(`fixture suggestion refused: ${created.reason}`);
  return created.suggestion;
}

function mappingSuggestion(): FixSuggestionFactV1 {
  return suggestion({ prerequisites: ['USER_CONFIRMATION', 'CREDENTIAL_MAPPING'] });
}

function endpointSuggestion(): FixSuggestionFactV1 {
  return suggestion({
    resource: { kind: 'ENDPOINT', nodeIdentityDigest: fixture.nodeDigest, pointer: fixture.pointer },
    prerequisites: ['USER_CONFIRMATION', 'ENDPOINT_COMPATIBILITY'],
  });
}

const CONFIRMATION: FixPrerequisiteEvidenceV1 = { code: 'USER_CONFIRMATION', evidenceDigest: DIGEST };

const INVENTORY = {
  schemaVersion: 'selected-credential-inventory-v1',
  credentials: [{ credentialId: 'cred-1', type: 'httpHeaderAuth' }],
};

function inventoryDigest(): string {
  const read = readCredentialInventory(INVENTORY);
  if (!read.ok) throw new Error('fixture inventory refused');
  return read.digest;
}

function mappingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeIdentityDigest: fixture.nodeDigest,
    credentialType: 'httpHeaderAuth',
    credentialId: 'cred-1',
    inventoryDigest: inventoryDigest(),
    ...overrides,
  };
}

function mappingReceipt(record: Record<string, unknown> = mappingRecord()): string {
  return JSON.stringify({ schemaVersion: 'selected-credential-mapping-v1', mapping: record, inventory: INVENTORY });
}

function identity(url: string): string {
  const digest = endpointTargetIdentitySha256(url);
  if (digest === undefined) throw new Error('fixture endpoint must be an http(s) URL');
  return digest;
}

function endpointSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeIdentityDigest: fixture.nodeDigest,
    oldEndpointSha256: canonicalJsonSha256(CURRENT_ENDPOINT),
    replacementUrl: REPLACEMENT_ENDPOINT,
    targetIdentityDigest: identity(REPLACEMENT_ENDPOINT),
    compatibilityDigest: COMPATIBILITY,
    ...overrides,
  };
}

function endpointReceipt(selection: Record<string, unknown> = endpointSelection()): string {
  return JSON.stringify({ schemaVersion: 'selected-endpoint-receipt-v1', selection });
}

type Harness = Readonly<{
  host: Readonly<{ inputRead: InputReadHost; plan?: typeof planFixSuggestion }>;
  reads: string[];
  planCalls: PlanFixRequestV1[];
}>;

function harness(files: Readonly<Record<string, string>> = {}, injectPlan = false): Harness {
  const reads: string[] = [];
  const planCalls: PlanFixRequestV1[] = [];
  const inputRead: InputReadHost = {
    readFile: async (p) => {
      reads.push(p);
      const content = files[p];
      if (content === undefined) throw new Error('ENOENT');
      return new TextEncoder().encode(content);
    },
  };
  if (!injectPlan) return { host: { inputRead }, reads, planCalls };
  return {
    host: {
      inputRead,
      plan: (request: PlanFixRequestV1) => {
        planCalls.push(request);
        return planFixSuggestion(request);
      },
    },
    reads,
    planCalls,
  };
}

function requestFor(overrides: Partial<FixPlanRequestV1> = {}): FixPlanRequestV1 {
  return {
    root: ROOT,
    input: 'workflow.json',
    suggestion: suggestion(),
    evidence: [CONFIRMATION],
    ...overrides,
  };
}

describe('runFixPlanV2', () => {
  it('dispatches the planner with exact input bytes and returns a READY plan', async () => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor(), test.host);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ status: 'READY', suggestionId: 'fix-1' });
    if (result.plan.status !== 'READY') return;
    expect(result.plan.patch).toEqual([{ op: 'remove', path: fixture.pointer }]);
    expect(result.suggestion?.id).toBe('fix-1');
    expect(result.prerequisites).toEqual([CONFIRMATION]);
    expect(test.planCalls).toHaveLength(1);
    expect(test.planCalls[0]?.bytes).toEqual(fixture.bytes);
  });

  it('validates the credential mapping receipt and forwards its evidence', async () => {
    const receipt = mappingReceipt();
    const test = harness({
      [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW,
      [toFsPathV2(ROOT, 'mapping.json')]: receipt,
    }, true);
    const result = await runFixPlanV2(requestFor({
      suggestion: mappingSuggestion(),
      mapping: 'mapping.json',
    }), test.host);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.status).toBe('READY');
    expect(result.prerequisites.map((entry) => entry.code).sort()).toEqual([
      'CREDENTIAL_MAPPING', 'USER_CONFIRMATION',
    ]);
    expect(result.prerequisites.find((entry) => entry.code === 'CREDENTIAL_MAPPING')?.evidenceDigest)
      .toBe(canonicalJsonSha256(mappingRecord()));
    expect(test.reads).toEqual([toFsPathV2(ROOT, 'workflow.json'), toFsPathV2(ROOT, 'mapping.json')]);
  });

  it('refuses a required credential mapping when the receipt is missing', async () => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor({ suggestion: mappingSuggestion() }), test.host);

    expect(result).toMatchObject({ ok: false, code: 'MISSING_OR_INVALID_CREDENTIAL_MAPPING' });
    expect(test.planCalls).toHaveLength(0);
  });

  it.each([
    ['an unreadable receipt', {}],
    ['invalid JSON', { [toFsPathV2(ROOT, 'mapping.json')]: '{' }],
    ['duplicate keys', { [toFsPathV2(ROOT, 'mapping.json')]: mappingReceipt().replace('"credentialId":"cred-1"', '"credentialId":"cred-1","credentialId":"cred-2"') }],
    ['a mapping for another node', { [toFsPathV2(ROOT, 'mapping.json')]: mappingReceipt(mappingRecord({ nodeIdentityDigest: 'e'.repeat(64) })) }],
    ['a stale inventory digest', { [toFsPathV2(ROOT, 'mapping.json')]: mappingReceipt(mappingRecord({ inventoryDigest: 'f'.repeat(64) })) }],
    ['a wrong credential type', { [toFsPathV2(ROOT, 'mapping.json')]: mappingReceipt(mappingRecord({ credentialType: 'httpBasicAuth' })) }],
  ])('refuses %s as MISSING_OR_INVALID_CREDENTIAL_MAPPING', async (_label, receiptFiles) => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW, ...receiptFiles }, true);
    const result = await runFixPlanV2(requestFor({
      suggestion: mappingSuggestion(),
      mapping: 'mapping.json',
    }), test.host);

    expect(result).toMatchObject({ ok: false, code: 'MISSING_OR_INVALID_CREDENTIAL_MAPPING' });
    expect(test.planCalls).toHaveLength(0);
  });

  it('validates the endpoint receipt against the current workflow endpoint', async () => {
    const test = harness({
      [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW,
      [toFsPathV2(ROOT, 'endpoint.json')]: endpointReceipt(),
    }, true);
    const result = await runFixPlanV2(requestFor({
      suggestion: endpointSuggestion(),
      endpointReceipt: 'endpoint.json',
    }), test.host);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.status).toBe('READY');
    expect(result.prerequisites.find((entry) => entry.code === 'ENDPOINT_COMPATIBILITY'))
      .toEqual({ code: 'ENDPOINT_COMPATIBILITY', evidenceDigest: COMPATIBILITY });
  });

  it.each([
    ['a stale old-endpoint digest', endpointReceipt(endpointSelection({ oldEndpointSha256: canonicalJsonSha256('http://old.example.com') }))],
    ['an HTTP-to-HTTPS-only substitution', endpointReceipt(endpointSelection({
      replacementUrl: 'https://insecure.example.com',
      targetIdentityDigest: identity('https://insecure.example.com'),
    }))],
    ['an unproven compatibility claim', endpointReceipt(endpointSelection({ compatibilityDigest: 'not-a-digest' }))],
  ])('refuses %s as MISSING_OR_INVALID_ENDPOINT', async (_label, receipt) => {
    const test = harness({
      [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW,
      [toFsPathV2(ROOT, 'endpoint.json')]: receipt,
    }, true);
    const result = await runFixPlanV2(requestFor({
      suggestion: endpointSuggestion(),
      endpointReceipt: 'endpoint.json',
    }), test.host);

    expect(result).toMatchObject({ ok: false, code: 'MISSING_OR_INVALID_ENDPOINT' });
    expect(test.planCalls).toHaveLength(0);
  });

  it('ignores receipts the selected fix does not require', async () => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor({
      mapping: 'unused-mapping.json',
      endpointReceipt: 'unused-endpoint.json',
    }), test.host);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.status).toBe('READY');
    expect(test.reads).toEqual([toFsPathV2(ROOT, 'workflow.json')]);
  });

  it('refuses caller-supplied evidence for receipt-backed prerequisites', async () => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor({
      suggestion: mappingSuggestion(),
      evidence: [CONFIRMATION, { code: 'CREDENTIAL_MAPPING', evidenceDigest: DIGEST }],
    }), test.host);

    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
    expect(test.planCalls).toHaveLength(0);
  });

  it('holds the planner as the authority for a malformed suggestion', async () => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor({ suggestion: { id: 'fix-1' } }), test.host);

    expect(result).toMatchObject({ ok: true, plan: { status: 'REFUSED', reason: 'MALFORMED_PATCH' } });
    expect(test.planCalls).toHaveLength(1);
  });

  it('returns the planner refusal for a stale source digest', async () => {
    const stale = analyze(WORKFLOW.replace('"method": "GET"', '"method": "GET", "retries": 1'));
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: new TextDecoder().decode(stale.bytes) }, true);
    const result = await runFixPlanV2(requestFor(), test.host);

    expect(result).toMatchObject({ ok: true, plan: { status: 'REFUSED', reason: 'STALE_SOURCE' } });
  });

  it.each([
    ['a traversal input', { input: '../escape.json' }],
    ['a stdin input', { input: '-' }],
    ['a relative root', { root: 'relative/root' }],
  ])('refuses %s as USAGE without reading', async (_label, overrides) => {
    const test = harness({ [toFsPathV2(ROOT, 'workflow.json')]: WORKFLOW }, true);
    const result = await runFixPlanV2(requestFor(overrides), test.host);

    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
    expect(test.reads).toEqual([]);
    expect(test.planCalls).toHaveLength(0);
  });
});
