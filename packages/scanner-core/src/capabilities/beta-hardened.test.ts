import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { BETA_HARDENED_PROFILE_MANIFEST, isProfileAdmitted } from './profile-manifest';
import type { AnalyzerContextV2 } from './scheduler';
import { createBetaHardenedCapabilityRegistry, scanHardenedCapabilitiesV2 } from './beta-hardened';
import { countInconsistency, omissionInconsistency } from './count-lattice';
import { createScanLocalTaint } from '../analyzers/taint/scan-local-taint';

const encoder = new TextEncoder();
function contextFor(text: string): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return {
    source: parsed.document, workflow: normalized.workflow, limits: DEFAULT_SCANNER_LIMITS_V2,
    target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) },
    semantics: { id: 'semantics', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() },
    rules: { id: 'rules', version: '1', digest: 'r'.repeat(64), rules: new Map() }, priorOutcomes: new Map(),
  };
}

/** An injected taint dependency that completed and observed nothing. */
function emptyTaint(context: AnalyzerContextV2) {
  return createScanLocalTaint(context, () => ({ status: 'COMPLETE', findings: [], diagnostics: [] }));
}

describe('beta-hardened capability adapter', () => {
  it('defines hardened capability order but never admits or executes it', () => {
    let invoked = false;
    const registry = createBetaHardenedCapabilityRegistry({ onRun: () => { invoked = true; } });
    const result = scanHardenedCapabilitiesV2(contextFor('{"nodes":[],"connections":{}}'), BETA_HARDENED_PROFILE_MANIFEST, registry);
    expect(isProfileAdmitted(BETA_HARDENED_PROFILE_MANIFEST)).toBe(false);
    expect(invoked).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.executions.map(({ id, required, status }) => ({ id, required, status }))).toEqual(BETA_HARDENED_PROFILE_MANIFEST.capabilities.map(({ id, required }) => ({ id, required, status: required ? 'FAILED' : 'DEGRADED' })));
  });

  it('preserves immutable prior outcomes and deterministic report-only output', () => {
    const context = contextFor('{"nodes":[],"connections":{}}');
    const before = JSON.stringify(context);
    const registry = createBetaHardenedCapabilityRegistry();
    const first = JSON.stringify(scanHardenedCapabilitiesV2(context, BETA_HARDENED_PROFILE_MANIFEST, registry));
    const second = JSON.stringify(scanHardenedCapabilitiesV2(context, BETA_HARDENED_PROFILE_MANIFEST, new Map([...registry.entries()].reverse())));
    expect(second).toBe(first);
    expect(JSON.stringify(context)).toBe(before);
  });

  it('registers every hardened analyzer runner for direct execution', () => {
    const context = contextFor(JSON.stringify({
      nodes: [
        { id: 'javascript', name: 'JavaScript', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return 1' } },
        { id: 'python', name: 'Python', type: 'n8n-nodes-base.code', parameters: { language: 'python', pythonCode: 'return 1' } },
      ],
      connections: {},
    }));
    const registry = createBetaHardenedCapabilityRegistry({ getTaint: emptyTaint(context) });
    const optionalIds = BETA_HARDENED_PROFILE_MANIFEST.capabilities.filter(({ required }) => !required).map(({ id }) => id);
    expect(optionalIds).toEqual([
      'expression-security', 'javascript-security', 'python-security', 'graph-semantics',
      'taint-confidentiality', 'taint-integrity', 'agentic-control',
    ]);
    for (const id of optionalIds) {
      const spec = registry.get(id);
      expect(spec?.run).toEqual(expect.any(Function));
      if (spec === undefined) throw new Error(`Missing hardened runner: ${id}`);
      const candidate = spec.run(context);
      expect(candidate).toMatchObject({ seen: 2, analyzed: 2 });
      // Each hardened runner publishes counts that pass both lattice rules for a two-node workflow.
      expect(countInconsistency(candidate, 2), `${id} counters`).toBeNull();
      expect(omissionInconsistency(candidate, candidate.diagnostics), `${id} omissions`).toBeNull();
    }
  });

  it('shares one scan-local taint computation across hardened consumers', () => {
    const context = contextFor(JSON.stringify({
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'command', name: 'Command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo ok' } },
      ],
      connections: { Start: { main: [[{ node: 'Command' }]] } },
    }));
    let calls = 0;
    const getTaint = createScanLocalTaint(context, () => {
      calls += 1;
      return { status: 'COMPLETE', findings: [], diagnostics: [] };
    });
    const registry = createBetaHardenedCapabilityRegistry({ getTaint });
    for (const id of ['graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control']) {
      const spec = registry.get(id);
      if (spec === undefined) throw new Error(`Missing hardened runner: ${id}`);
      expect(spec.run(context)).toMatchObject({ seen: 2, analyzed: 2 });
    }
    expect(calls).toBe(1);
  });

  it('does not publish a limited legacy taint run as complete', () => {
    const context = contextFor('{"nodes":[],"connections":{}}');
    const getTaint = createScanLocalTaint(context, () => ({ status: 'LIMITED', findings: [], diagnostics: [] }));
    const registry = createBetaHardenedCapabilityRegistry({ getTaint });
    for (const id of ['graph-semantics', 'taint-confidentiality', 'agentic-control']) {
      const spec = registry.get(id);
      if (spec === undefined) throw new Error(`Missing hardened runner: ${id}`);
      const candidate = spec.run(context);
      expect(candidate.diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
      expect(candidate.omitted).toBeGreaterThan(0);
    }
    const integrity = registry.get('taint-integrity')!.run(context);
    expect(integrity.diagnostics.map(({ code }) => code)).toEqual(['DEPENDENCY_UNAVAILABLE']);
    expect(integrity.omitted).toBe(1);
  });

  it('fails closed for every taint consumer when its accessor is absent', () => {
    const context = contextFor(JSON.stringify({
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'command', name: 'Command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo ok' } },
      ],
      connections: { Start: { main: [[{ node: 'Command' }]] } },
    }));
    const taintIds = ['graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control'];
    const without = createBetaHardenedCapabilityRegistry();
    for (const id of taintIds) {
      const spec = without.get(id);
      if (spec === undefined) throw new Error(`Missing hardened runner: ${id}`);
      const candidate = spec.run(context);
      // An absent dependency is a typed failure, never a recomputed taint result.
      expect(candidate, id).toMatchObject({ findings: [], facts: [], traces: [], seen: 2, analyzed: 2, skipped: 0, omitted: 1 });
      const expected = id === 'taint-integrity' ? 'DEPENDENCY_UNAVAILABLE' : 'REQUIRED_CAPABILITY_FAILED';
      expect(candidate.diagnostics.map(({ code, capabilityId }) => ({ code, capabilityId })), id)
        .toEqual([{ code: expected, capabilityId: id }]);
    }
    const withAccessor = createBetaHardenedCapabilityRegistry({ getTaint: emptyTaint(context) });
    for (const id of taintIds) {
      const spec = withAccessor.get(id);
      if (spec === undefined) throw new Error(`Missing hardened runner: ${id}`);
      if (id === 'taint-integrity') {
        expect(spec.run(context), id).toMatchObject({ findings: [], facts: [], traces: [],
          seen: 2, analyzed: 2, skipped: 0, omitted: 1 });
      } else {
        expect(spec.run(context), id).toMatchObject({ findings: [], diagnostics: [], seen: 2, analyzed: 2, skipped: 0, omitted: 0 });
      }
    }
  });

  it('reports a count row for every capability declared by the hardened manifest without admitting it', () => {
    const result = scanHardenedCapabilitiesV2(contextFor('{"nodes":[],"connections":{}}'), BETA_HARDENED_PROFILE_MANIFEST, createBetaHardenedCapabilityRegistry());
    expect(isProfileAdmitted(BETA_HARDENED_PROFILE_MANIFEST)).toBe(false);
    expect(result.candidates).toEqual([]);
    // Unadmitted, but every declared capability still publishes the counters of the failure it was
    // closed with: nothing ran and one unit was omitted.
    expect(result.executions.map(({ id, status, seen, analyzed, skipped, omitted }) => ({ id, status, seen, analyzed, skipped, omitted })))
      .toEqual(BETA_HARDENED_PROFILE_MANIFEST.capabilities.map(({ id, required }) => ({ id, status: required ? 'FAILED' : 'DEGRADED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 })));
  });

  it('completes the agentic capability for an agent whose input is not tainted', () => {
    const context = contextFor(JSON.stringify({
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'agent', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
        { id: 'tool', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} },
      ],
      connections: { Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] }, Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] } },
    }));
    const registry = createBetaHardenedCapabilityRegistry({ getTaint: emptyTaint(context) });
    const spec = registry.get('agentic-control');
    if (spec === undefined) throw new Error('Missing hardened runner: agentic-control');
    const candidate = spec.run(context);
    expect(candidate).toMatchObject({ findings: [], diagnostics: [], seen: 3, analyzed: 3, skipped: 0, omitted: 0 });
  });

  it('keeps the taint stage diagnostics when the AI stage has no coupling value', () => {
    const context = contextFor(JSON.stringify({
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.customTrigger', parameters: {} },
        { id: 'agent', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
        { id: 'tool', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} },
      ],
      connections: { Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] }, Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] } },
    }));
    const getTaint = createScanLocalTaint(context, () => ({
      status: 'COMPLETE', findings: [], diagnostics: [{ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' } }],
    }));
    const registry = createBetaHardenedCapabilityRegistry({ getTaint });
    const spec = registry.get('agentic-control');
    if (spec === undefined) throw new Error('Missing hardened runner: agentic-control');
    const candidate = spec.run(context);
    expect(candidate.findings).toEqual([]);
    expect(candidate.diagnostics.map(({ code }) => code)).toContain('REQUIRED_STAGE_FAILURE');
  });

  it('retains optional analyzer limit counters when hardened runners are reachable', () => {
    const registry = createBetaHardenedCapabilityRegistry();
    const spec = registry.get('javascript-security');
    if (spec === undefined) throw new Error('Missing JavaScript hardened runner');
    const source = 'x'.repeat(100_001);
    const candidate = spec.run(contextFor(JSON.stringify({
      nodes: [{ id: 'javascript', name: 'JavaScript', type: 'n8n-nodes-base.code', parameters: { jsCode: source } }],
      connections: {},
    })));
    expect(candidate.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OPTIONAL_LIMIT_EXCEEDED', observed: 1, maximum: 0, omitted: 1, aggregateEffect: 'DEGRADED', assessmentEligible: true }),
    ]));
  });
});
