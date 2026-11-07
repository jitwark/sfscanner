import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import {
  ENGINE_BUILD_DIGEST_V2 as coreEngine,
  LIMITS_AUTHORITY_DIGEST_V2 as coreLimits,
  PROFILE_MANIFEST_DIGEST_V2 as coreProfile,
  RULE_PACK_DIGEST_V2 as coreRules,
  SEMANTIC_CATALOGUE_DIGEST_V2 as coreSemantics,
  scanWorkflowV2,
} from '@hub/scanner-core/v2';
import {
  ADMITTED_PROFILE_V2, BUILTIN_LIMITS_AUTHORITY_V2, BUILTIN_RULESET_AUTHORITY_V2, BUILTIN_SEMANTICS_AUTHORITY_V2,
  BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2 as cliScoped,
  PROFILE_MANIFEST_DIGEST_V2 as cliProfile,
} from './contracts';
import type { BatchResultV2 } from './batch-runner';
import { explainDocumentV2, profilesDocumentV2, rulesDocumentV2, versionDocumentV2 } from './commands';
import { projectBatchV2 } from './json-output';
import { handleMcpRequest } from './mcp';
import { serializeNdjsonV2 } from './ndjson-output';
import { BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2 as coreScoped, authorityIsIntact } from '../../../scanner-core/src/v2/admitted-registry';
import { resolveReviewedScopedSemantics, reviewedScopedSemanticsAreIntact } from '../../../scanner-core/src/semantics/generic-fallback';

function scannedWorkflow() {
  const scanned = scanWorkflowV2({
    bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'),
    profile: { id: 'beta-default', version: '2.0.0' },
    limits: DEFAULT_SCANNER_LIMITS_V2,
  });
  if (!scanned.ok) throw new Error(scanned.code);
  return scanned.result;
}

function scannedBatch(): BatchResultV2 {
  const result = scannedWorkflow();
  return {
    ok: true, items: [{ label: 'workflow.json', status: 'COMPLETED', result: { ok: true, result } }],
    cancelled: false, completed: 1, failed: 0, concurrency: 1,
  };
}

describe('published authority pins', () => {
  it('equal the values computed by scanner-core', () => {
    expect(cliProfile).toBe(coreProfile);
    expect(BUILTIN_RULESET_AUTHORITY_V2.digest).toBe(coreRules);
    expect(BUILTIN_SEMANTICS_AUTHORITY_V2.digest).toBe(coreSemantics);
    expect(coreLimits).toBe(BUILTIN_LIMITS_AUTHORITY_V2.digest);
    expect(DEFAULT_SCANNER_LIMITS_V2.maxNodes).toBe(5_000);
  });

  it('independently pins the reviewed scope and exact source receipt', () => {
    expect(cliScoped).not.toBe(coreScoped);
    expect(cliScoped).toEqual(coreScoped);
    const receipt = readFileSync(new URL('../../../../docs/scanner/semantic-source-receipts.json', import.meta.url));
    expect(createHash('sha256').update(receipt).digest('hex')).toBe(cliScoped.sourceReceiptSha256);
    const source = JSON.parse(receipt.toString()) as { packages: { package: string; files: unknown[] }[]; documentsRecords: Record<string, string[]> };
    expect(source.packages.find((entry) => entry.package === 'n8n-nodes-base')?.files).toContainEqual({
      path: 'dist/nodes/Google/Gmail/v2/MessageDescription.js', bytes: 17847,
      sha256: '1983d7d70037b76f1d5bd7ea8597141372f01da27f85ddd53d97e3353bb407a9',
    });
    expect(source.documentsRecords['message-mcp.gmail'].some((ref) => ref.endsWith('MessageDescription.js'))).toBe(false);
    expect(authorityIsIntact()).toBe(true);
    expect(reviewedScopedSemanticsAreIntact(cliScoped.digest)).toBe(true);
    expect(reviewedScopedSemanticsAreIntact('0'.repeat(64))).toBe(false);
  });

  it.each([
    ['send', '2.2.0', 'ELIGIBLE', true], ['sendAndWait', '2.2.0', 'ELIGIBLE', false],
    ['send', '2.1.0', 'ELIGIBLE', false], ['send', '2.2.0', 'INDETERMINATE', false],
    ['={{ $json.operation }}', '2.2.0', 'ELIGIBLE', false],
  ] as const)('reviewed accessor preserves exact scope: %s/%s/%s', (operation, typeVersion, scoringEligibility, covered) => {
    const result = resolveReviewedScopedSemantics({ type: 'n8n-nodes-base.gmail', typeVersion, scoringEligibility,
      parameters: [{ pointer: '/nodes/0/parameters/operation', value: operation }] });
    expect(result !== null).toBe(covered);
  });

  it('does not widen scope for a different resource or duplicate/unreadable selectors', () => {
    const query = { type: 'n8n-nodes-base.gmail', typeVersion: '2.2.0', scoringEligibility: 'ELIGIBLE' as const };
    const operation = { pointer: '/nodes/0/parameters/operation', value: 'send' };
    expect(resolveReviewedScopedSemantics({ ...query, parameters: [operation, { pointer: '/nodes/0/parameters/resource', value: 'label' }] })).toBeNull();
    expect(resolveReviewedScopedSemantics({ ...query, parameters: [operation, operation] })).toBeNull();
    expect(resolveReviewedScopedSemantics({ ...query, parameters: [{ ...operation, value: null }] })).toBeNull();
  });

  it('reports the core engine and limits digests in a real scan', () => {
    const scanned = scanWorkflowV2({
      bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'),
      profile: { id: 'beta-default', version: '2.0.0' },
      limits: DEFAULT_SCANNER_LIMITS_V2,
    });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.result.engine.buildDigest).toBe(coreEngine);
    expect(scanned.result.limits.digest).toBe(coreLimits);
    expect(scanned.result.limits.digest).toBe(BUILTIN_LIMITS_AUTHORITY_V2.digest);
  });
});

describe('machine identity parity', () => {
  it('reports the core engine build digest in the version document', () => {
    const result = scannedWorkflow();
    const version = versionDocumentV2();
    expect({ id: version.engine.id, version: version.engine.version }).toEqual({ id: result.engine.id, version: result.engine.version });
    expect(version.engine.buildDigest).toBe(result.engine.buildDigest);
    expect(version.engine.buildDigest).toBe(coreEngine);
  });

  it('uses one tool identity on every machine surface', async () => {
    const input = scannedBatch();
    const result = scannedWorkflow();
    const envelopeTool = projectBatchV2(input).envelope.tool;
    // Recompute the documented fold from the authorities instead of echoing the constant.
    const expectedDigest = createHash('sha256').update(canonicalizeJson({
      engine: result.engine.id, version: result.engine.version, profile: ADMITTED_PROFILE_V2,
      ruleset: BUILTIN_RULESET_AUTHORITY_V2.digest, semantics: BUILTIN_SEMANTICS_AUTHORITY_V2.digest,
      scopedSemantics: cliScoped,
    })).digest('hex');
    expect(envelopeTool).toEqual({ name: 'n8n-scan', version: '0.1.0', buildDigest: expectedDigest });

    const explained = explainDocumentV2('N8N_EXECUTE_COMMAND');
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    for (const document of [rulesDocumentV2(), profilesDocumentV2(), explained.document]) {
      expect(document.tool).toEqual(envelopeTool);
    }
    const header = JSON.parse(serializeNdjsonV2(input).split('\n')[0]!) as { tool: unknown };
    expect(header.tool).toEqual(envelopeTool);
    expect({ name: versionDocumentV2().name, version: versionDocumentV2().cliVersion })
      .toEqual({ name: envelopeTool.name, version: envelopeTool.version });

    const directory = await mkdtemp(join(tmpdir(), 'scanner-identity-'));
    try {
      await writeFile(join(directory, 'workflow.json'), '{"nodes":[],"connections":{}}');
      const response = await handleMcpRequest({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['workflow.json'] } },
      }, { cwd: directory });
      const payload = response?.result as { content: Array<{ text: string }> };
      const mcpEnvelope = JSON.parse(payload.content[0]!.text) as { tool: unknown };
      expect(mcpEnvelope.tool).toEqual(envelopeTool);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
