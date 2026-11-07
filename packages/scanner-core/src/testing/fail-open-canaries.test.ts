import { DEFAULT_SCANNER_LIMITS, SCANNER_RESULT_SCHEMA_VERSION, toWorkflowParseOptions } from '@hub/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../canonical-json';
import { scanWorkflowCore, type CoreAnalyzer, type ScanWorkflowCoreResult } from '../engine/engine';
import { analyzeAiCapabilities } from '../analyzers/ai/ai-capability-analysis';
import { analyzeWorkflowJavaScript } from '../analyzers/code/javascript-analysis';
import { analyzeWorkflowPython } from '../analyzers/code/python-analysis';
import { analyzeWorkflowTaint, type TaintAnalysisResult } from '../analyzers/taint/taint-analysis';
import { classifyAnchoredPlaceholder } from '../analyzers/expression/placeholder-classifier';
import { V1_GOLDEN_CASES } from '../__fixtures__/v1-goldens';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '../__fixtures__/v2-adapter-fixtures';
import { projectResultV2ToV1 } from '../compat/v1-projector';
import { V2_PROJECTION_FIXTURE } from '../compat/__fixtures__/projection';
import { resolvePolicyProfile, type PolicyProfileResult } from '../policies/profile';
import { scanWorkflowV2 } from '../v2';
import { parseWorkflowJson } from '../workflow';
import { SCANNER_VERSION } from '../scanner-version';

const encoder = new TextEncoder();
const v2 = (source: string, overrides: Record<string, unknown> = {}) => scanWorkflowV2({ bytes: encoder.encode(source), profile: V2_ADAPTER_PROFILE, ...overrides });
const emptyWorkflow = () => {
  const parsed = parseWorkflowJson('{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","parameters":{}}],"connections":{}}');
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
};
function digest(value: unknown): string {
  const serialized = canonicalizeJson(JSON.parse(JSON.stringify(value)));
  return bytesToHex(sha256(encoder.encode(serialized)));
}
function compatibilityProjection(result: ScanWorkflowCoreResult, profileId: string): unknown {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION, scannerVersion: SCANNER_VERSION, policyProfile: profileId,
    analysisStatus: result.analysisStatus, analysisDiagnostics: result.diagnostics, summary: result.summary,
    findings: result.findings.map((finding) => { const { sourceSpan: _sourceSpan, ...location } = finding.location; return { ...finding, location }; }),
  };
}
function analyzersFor(profile: PolicyProfileResult): readonly CoreAnalyzer[] {
  if (!profile.ok || !profile.includesJavaScriptAnalysis) return [];
  const analyzers: CoreAnalyzer[] = [analyzeWorkflowJavaScript, analyzeWorkflowPython];
  let propagation: TaintAnalysisResult['propagation'];
  analyzers.push((workflow) => { const result = analyzeWorkflowTaint(workflow); propagation = result.propagation; return result; });
  analyzers.push((workflow) => propagation ? analyzeAiCapabilities(workflow, propagation) : { findings: [], diagnostics: [] });
  return analyzers;
}

describe('scanner fail-open mutation canaries', () => {
  it('keeps v1 compatibility goldens byte-identical', () => {
    for (const fixture of V1_GOLDEN_CASES) {
      const parsed = parseWorkflowJson(fixture.json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const profile = resolvePolicyProfile(fixture.profile);
      expect(profile.ok).toBe(true);
      if (!profile.ok) continue;
      const result = scanWorkflowCore(parsed.workflow, { policies: profile.createPolicies(), analyzers: analyzersFor(profile), ruleCatalog: profile.ruleCatalog, maxAnalyzerFindings: 100 });
      expect(digest(compatibilityProjection(result, fixture.profile))).toBe(fixture.expectedDigest);
    }
  });

  it('keeps v2 adapter outcomes and rejection codes differential', () => {
    for (const fixture of V2_ADAPTER_FIXTURE_MATRIX) {
      const result = v2(fixture.json);
      if (fixture.kind === 'rejected') {
        expect(result).toMatchObject({ ok: false, code: fixture.rejectionCode });
      } else {
        expect(result.ok).toBe(true);
        if (result.ok && fixture.expectedStatus) expect(result.result.analysis.status).toBe(fixture.expectedStatus);
      }
    }
  });

  it('never restores unknown-rule fallback, and keeps unreadable semantics fail-closed', () => {
    // The posture change is labelled, not silent: an uncatalogued node is scanned under the generic
    // fallback and says so (degraded advisory), and a node whose parameters were not readable still
    // withholds the verdict instead of being assumed assessable.
    const uncatalogued = v2('{"nodes":[{"id":"custom","name":"Custom","type":"@example/custom-node.unknown","parameters":{}}],"connections":{}}');
    expect(uncatalogued).toMatchObject({ ok: true });
    if (uncatalogued.ok) {
      expect(uncatalogued.result.analysis.status).toBe('DEGRADED');
      expect(uncatalogued.result.analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'DEGRADED', assessmentEligible: true }));
    }
    const unreadable = v2('{"nodes":[{"id":"custom","name":"Custom","type":"@example/custom-node.unknown","parameters":"not-an-object"}],"connections":{}}');
    expect(unreadable).toMatchObject({ ok: true });
    if (unreadable.ok) {
      expect(unreadable.result.analysis.status).toBe('INDETERMINATE');
      expect(unreadable.result.assessment).toBeNull();
      expect(unreadable.result.analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'INDETERMINATE' }));
    }
    expect(projectResultV2ToV1({ ...V2_PROJECTION_FIXTURE, findings: [{ ...V2_PROJECTION_FIXTURE.findings[0]!, ruleId: 'UNKNOWN_RULE' }] })).toMatchObject({ ok: false, reason: 'UNKNOWN_RULE' });
  });

  it('preserves caps and diagnostics instead of producing a false clean', () => {
    const source = JSON.stringify({ nodes: [{ id: 'a', name: 'A', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, { id: 'b', name: 'B', type: 'n8n-nodes-base.manualTrigger', parameters: {} }], connections: {} });
    expect(v2(source, { limits: { maxNodes: 1 } })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX' });
    const unknown = v2('{"nodes":[{"id":"custom","name":"Custom","type":"@example/custom-node.unknown","parameters":{}}],"connections":{}}');
    expect(unknown).toMatchObject({ ok: true });
    if (unknown.ok) expect(unknown.result.analysis.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not swallow native analyzer failures', () => {
    expect(() => scanWorkflowCore(emptyWorkflow(), { policies: [], analyzers: [() => { throw new Error('analyzer-secret'); }], ruleCatalog: [] })).toThrow('analyzer-secret');
  });

  it('keeps authentication and placeholder anchors exact', () => {
    for (const value of ['<your-password>', '[API_KEY]', '__PLACEHOLDER_VALUE__', '$env.API_KEY']) expect(classifyAnchoredPlaceholder(value)).toMatchObject({ kind: 'PLACEHOLDER' });
    for (const value of ['prefix <your-password>', '<your-password> suffix', 'example-token-real', '[sk_live_12345678]']) expect(classifyAnchoredPlaceholder(value)).toBeUndefined();
    const result = v2(JSON.stringify({ nodes: [
      { id: 'auth', name: 'Auth', type: 'n8n-nodes-base.httpRequest', parameters: { headers: { Authorization: 'Bearer literal' } } },
      { id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { authentication: 'none' } },
    ], connections: {} }));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.result.findings.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining(['RAW_AUTH_HEADER', 'WEBHOOK_EXPOSURE']));
      expect(result.result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'node.configuration.v2', properties: expect.objectContaining({ observation: 'AUTH_HEADER', literalValue: true }) })]));
    }
  });

  it('does not read clocks, network, or execute embedded code', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network'); });
    const execution = vi.spyOn(globalThis, 'eval').mockImplementation(() => { throw new Error('execution'); });
    try {
      const result = v2('{"nodes":[{"id":"code","name":"Code","type":"n8n-nodes-base.code","parameters":{"jsCode":"eval(input)"}}],"connections":{}}');
      expect(result.ok).toBe(true);
      expect(network).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); network.mockRestore(); execution.mockRestore(); }
  });
});
