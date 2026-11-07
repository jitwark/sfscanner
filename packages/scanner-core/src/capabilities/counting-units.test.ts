import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2 } from '../v2/scan-workflow';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { ScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import { BETA_HARDENED_PROFILE_MANIFEST } from './profile-manifest';
import { createBetaHardenedCapabilityRegistry } from './beta-hardened';
import { countInconsistency, omissionInconsistency, type CapabilityCountsV2 } from './count-lattice';
import { evaluateJavaScriptSecurity } from './javascript-security';
import type { AnalyzerContextV2 } from './scheduler';

/**
 * The declared counting units of the normative spec, pinned to the rows the producer actually publishes:
 * one document unit for source normalization, one workflow-level stage for the workflow-scoped stages,
 * and one normalized node for every node-scoped capability. The counters are checked as a record of work
 * rather than a partition, because the analyzers deliberately overlap them.
 */
const encoder = new TextEncoder();
const PROFILE = Object.freeze({ id: 'beta-default', version: '2.0.0' });
const WORKFLOW = (types: readonly string[]): string => JSON.stringify({
  nodes: types.map((type, index) => ({ id: `n${index}`, name: `N${index}`, type, typeVersion: 1, parameters: {} })),
  connections: {},
});
const WORKFLOWS: readonly Readonly<{ label: string; json: string; nodes: number }>[] = Object.freeze([
  Object.freeze({ label: 'empty', json: WORKFLOW([]), nodes: 0 }),
  Object.freeze({ label: 'one node', json: WORKFLOW(['n8n-nodes-base.executeCommand']), nodes: 1 }),
  Object.freeze({ label: 'three nodes', json: WORKFLOW(['n8n-nodes-base.executeCommand', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code']), nodes: 3 }),
]);
const countersOf = ({ seen, analyzed, skipped, omitted }: CapabilityCountsV2): CapabilityCountsV2 => ({ seen, analyzed, skipped, omitted });

function scan(json: string, limits?: Readonly<Record<string, number>>): ScannerResultV2 {
  const scanned = scanWorkflowV2({ bytes: encoder.encode(json), profile: PROFILE, ...(limits === undefined ? {} : { limits }) });
  if (!scanned.ok) throw new Error(`scan failed: ${scanned.code}`);
  return scanned.result;
}

function contextFor(json: string, limits: typeof DEFAULT_SCANNER_LIMITS_V2 = DEFAULT_SCANNER_LIMITS_V2): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(json), limits);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, limits);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return {
    source: parsed.document, workflow: normalized.workflow, limits,
    target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) },
    semantics: { id: 'semantics', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() },
    rules: { id: 'rules', version: '1', digest: 'r'.repeat(64), rules: new Map() }, priorOutcomes: new Map(),
  };
}
function codeNodeFor(code: string): Readonly<{ context: AnalyzerContextV2; node: NonNullable<AnalyzerContextV2['workflow']['nodes'][number]> }> {
  const context = contextFor(JSON.stringify({ nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: code } }], connections: {} }));
  const node = context.workflow.nodes[0];
  if (node === undefined) throw new Error('code node fixture failed');
  return { context, node };
}

describe('declared capability counting units', () => {
  it('counts one document unit for source normalization and one workflow stage for the workflow-scoped stages', () => {
    for (const { label, json } of WORKFLOWS) {
      const rows = new Map(scan(json).analysis.capabilities.map((row) => [row.id, row]));
      for (const id of ['source-normalization', 'workflow-insights', 'assessment', 'presentation-facts']) {
        expect(rows.get(id), `${label} ${id} row`).toBeDefined();
        expect(countersOf(rows.get(id)!), `${label} ${id} counters`).toEqual({ seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
        expect(rows.get(id)?.status, `${label} ${id} status`).toBe('COMPLETED');
      }
    }
  });

  it('counts one normalized node per node-scoped row and completes a capability with no eligible unit', () => {
    for (const { label, json, nodes } of WORKFLOWS) {
      const result = scan(json);
      const row = result.analysis.capabilities.find(({ id }) => id === 'structural-policies');
      expect(row, `${label} structural-policies row`).toBeDefined();
      expect(countersOf(row!), `${label} structural counters`).toEqual({ seen: nodes, analyzed: nodes, skipped: 0, omitted: 0 });
      // An empty workflow grants the node-scoped capability no eligible unit, so zero counters complete it.
      expect(row?.status, `${label} structural status`).toBe('COMPLETED');
      expect(countInconsistency(countersOf(row!), nodes), `${label} structural lattice`).toBeNull();
      expect(result.analysis.status, `${label} aggregate`).toBe('COMPLETE');
    }
  });

  it('measures every hardened analyzer in the same node unit the scheduler scopes it to', () => {
    const registry = createBetaHardenedCapabilityRegistry();
    const optionalIds = BETA_HARDENED_PROFILE_MANIFEST.capabilities.filter(({ required }) => !required).map(({ id }) => id);
    expect(optionalIds).toEqual([
      'expression-security', 'javascript-security', 'python-security', 'graph-semantics',
      'taint-confidentiality', 'taint-integrity', 'agentic-control',
    ]);
    for (const { label, json, nodes } of WORKFLOWS) {
      const context = contextFor(json);
      for (const id of optionalIds) {
        const spec = registry.get(id);
        if (spec === undefined) throw new Error(`missing hardened runner: ${id}`);
        const candidate = spec.run(context);
        const counters = countersOf(candidate);
        expect(counters.seen, `${label} ${id} seen`).toBe(nodes);
        expect(counters.analyzed, `${label} ${id} analyzed`).toBe(nodes);
        expect(counters.skipped, `${label} ${id} skipped`).toBe(0);
        expect(countInconsistency(counters, nodes), `${label} ${id} lattice`).toBeNull();
        expect(omissionInconsistency(counters, candidate.diagnostics), `${label} ${id} omissions`).toBeNull();
      }
    }
  });

  it('accepts a finer-unit analyzer whose analyzed and omitted units together exceed seen', () => {
    const { context, node } = codeNodeFor('x'.repeat(100_001));
    const candidate = evaluateJavaScriptSecurity(node, context);
    // One seen node, one embedded source inspected, and that source's truncation recorded as an omission.
    expect(countersOf(candidate)).toEqual({ seen: 1, analyzed: 1, skipped: 0, omitted: 1 });
    expect(candidate.analyzed + candidate.skipped + candidate.omitted, 'the counters are not a partition of seen').toBeGreaterThan(candidate.seen);
    expect(countInconsistency(countersOf(candidate), context.workflow.nodes.length)).toBeNull();
    expect(omissionInconsistency(countersOf(candidate), candidate.diagnostics)).toBeNull();
    expect(candidate.diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('records a budget omission outside the row counters while still degrading the aggregate', () => {
    const truncated = scan(WORKFLOW(['n8n-nodes-base.executeCommand']), { maxStoredSourceSpans: 1 });
    const row = truncated.analysis.capabilities.find(({ id }) => id === 'source-normalization');
    expect(row?.status, 'span loss is charged to usage, not to the row').toBe('COMPLETED');
    expect(row?.omitted, 'source-normalization row omitted').toBe(0);
    expect(truncated.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans')?.omitted, 'recorded usage omission').toBeGreaterThan(0);
    expect(truncated.analysis.status, 'aggregate degrades').toBe('DEGRADED');
    expect(countInconsistency(countersOf(row!), 1)).toBeNull();
    expect(omissionInconsistency(countersOf(row!), truncated.analysis.diagnostics.filter(({ capabilityId }) => capabilityId === row?.id))).toBeNull();
  });
});
