import { describe, expect, it, vi } from 'vitest';
import * as producerModule from '../analyzers/taint/scan-local-producer';
import { scanWorkflowV2 } from './index';
import { scanWorkflowDormantHardenedV2 } from './scan-workflow';
import { validateTargetContextV3 } from '../semantics/target-context';
import { createNodeIdentityDigest } from '../workflow-v2/node-edge-identity';

const bytes = (value: string) => new TextEncoder().encode(value);
const profile = { id: 'beta-default', version: '2.0.0' } as const;
const target = (overrides: Record<string, unknown> = {}) => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [], ...overrides });

describe('scanWorkflowV2 semantic context bridge', () => {
  it('publishes canonical requested UNAVAILABLE facts without a caller-supplied snapshot', () => {
    const context = target({ communityPackages: [{ name: 'pkg', version: '2.0.0' }, { name: 'pkg', version: '1.2.3' }] });
    const result = scanWorkflowV2({ bytes: bytes('{"nodes":[],"connections":{}}'), profile, target: context, advisoryRequest: { requested: true, inventoryState: 'DECLARED' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evaluation = result.result.facts.find((fact) => fact.kind === 'advisory.evaluation.v1');
    expect(evaluation?.properties).toMatchObject({
      evaluationState: 'UNAVAILABLE', evaluationReason: 'NO_ADMITTED_SNAPSHOT',
      targetDigest: context.contextDigest, packagesRequested: 2, coverageClaimed: false,
    });
    expect(result.result.facts.filter((fact) => fact.kind === 'advisory.package-coverage.v1').map((fact) => fact.properties))
      .toEqual([
        { packageName: 'pkg', packageVersion: '1.2.3', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
        { packageName: 'pkg', packageVersion: '2.0.0', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
      ]);
    expect(result.result.facts.some((fact) => fact.kind === 'advisory.applicability.v3')).toBe(false);
  });

  it('changes v2 result identity when explicit target context changes', () => {
    const source = bytes('{"nodes":[],"connections":{}}');
    const withoutTarget = scanWorkflowV2({ bytes: source, profile, target: target() });
    const withTarget = scanWorkflowV2({ bytes: source, profile, target: target({ n8nVersion: '1.0.0' }) });
    expect(withoutTarget.ok).toBe(true);
    expect(withTarget.ok).toBe(true);
    if (!withoutTarget.ok || !withTarget.ok) return;
    expect(withoutTarget.result.input.semanticSha256).not.toBe(withTarget.result.input.semanticSha256);
  });

  it('retains dynamic destination inventory with an empty allowlist', () => {
    const result = scanWorkflowV2({
      bytes: bytes('{"nodes":[{"id":"http","name":"HTTP","type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"={{$json.url}}"}}],"connections":{}}'),
      profile,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.analysis.status).toBe('COMPLETE');
      expect(result.result.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'destination.v2',
          properties: expect.objectContaining({ parameterPath: '/url', valueMode: 'DYNAMIC', authorityState: 'UNKNOWN' }),
          subject: expect.objectContaining({
            kind: 'SOURCE',
            source: expect.objectContaining({ pointer: '/nodes/0/parameters/url' }),
          }),
        }),
      ]));
    }
  });

  it('links a dynamic allowlist diagnostic to the structural execution and returns INDETERMINATE', () => {
    const result = scanWorkflowV2({
      bytes: bytes('{"nodes":[{"id":"http","name":"HTTP","type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"={{$json.url}}"}}],"connections":{}}'),
      profile, approvedDomains: ['approved.example'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('INDETERMINATE');
    const diagnostic = result.result.analysis.diagnostics.find(({ code }) => code === 'POLICY_EXECUTION_FAILED');
    expect(diagnostic).toMatchObject({ code: 'POLICY_EXECUTION_FAILED', capabilityId: 'structural-policies' });
    expect(result.result.analysis.capabilities.find(({ id }) => id === 'structural-policies')?.diagnosticIds).toContain(diagnostic?.id);
  });

  it('publishes structural, dependency and effect facts with a dynamic destination UNKNOWN', () => {
    const result = scanWorkflowV2({
      bytes: bytes('{"nodes":[{"id":"http","name":"HTTP","type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"={{$json.url}}"}}],"connections":{}}'),
      profile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.result.facts.map(({ kind }) => kind);
    expect(kinds).toEqual(expect.arrayContaining([
      'workflow.structure.v1', 'workflow.dependencies.v1', 'workflow.effects.v1', 'destination.v2',
    ]));
    expect(result.result.facts.find(({ kind }) => kind === 'workflow.structure.v1')?.properties)
      .toMatchObject({ total: 1, executable: 1, vertices: 1, edges: 0 });
    expect(result.result.facts.find(({ kind }) => kind === 'workflow.dependencies.v1')?.properties)
      .toMatchObject({ totalNodes: 1, reviewedNodes: 1, unknownNodes: 0 });
    expect(result.result.facts.find(({ kind }) => kind === 'destination.v2')?.properties)
      .toMatchObject({ valueMode: 'DYNAMIC', authorityState: 'UNKNOWN' });
  });

  it('does not duplicate semantic miss diagnostics during v2 composition', () => {
    const result = scanWorkflowV2({
      bytes: bytes('{"nodes":[{"id":"custom","name":"Custom","type":"@example/custom-node.unknown","parameters":{}}],"connections":{}}'),
      profile,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toHaveLength(1);
    }
  });
  it('uses the reviewed Gmail scope and degrades only unknown selectors', () => {
    const scan = (parameters: Record<string, unknown>) => scanWorkflowV2({
      bytes: bytes(JSON.stringify({ nodes: [{ id: 'gmail', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.2, parameters }], connections: {} })),
      profile,
    });
    const known = scan({ resource: 'message', operation: 'send' });
    const unknown = scan({ resource: 'message', operation: 'not-a-gmail-operation' });
    expect(known.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    if (!known.ok || !unknown.ok) return;
    expect(known.result.analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toHaveLength(0);
    expect(unknown.result.analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toHaveLength(1);
  });

  it('redacts secret-shaped node identifiers without changing identity or provenance', () => {
    const workflow = (id: string, name: string) => JSON.stringify({
      nodes: [
        { id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { url: 'https://other.example/hook' } },
        { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
      ],
      connections: { [name]: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
    });
    const canaries = ['api_key_canary_9ab712345678', 'secret_token_canary_AWS_credential'] as const;
    const source = workflow(canaries[0], canaries[1]);
    const redacted = scanWorkflowV2({ bytes: bytes(source), profile, approvedDomains: ['approved.example'] });
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;
    const json = JSON.stringify(redacted.result);
    for (const canary of canaries) expect(json).not.toContain(canary);
    const index = redacted.result.findings.findIndex(({ subject }) => subject.kind === 'NODE');
    expect(index).toBeGreaterThanOrEqual(0);
    const node = redacted.result.findings[index]!.subject;
    if (node.kind !== 'NODE') return;
    expect(node.node).toMatchObject({ ordinal: 0, explicitId: '[REDACTED]', name: '[REDACTED]' });
    expect(node.node.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(node.node.identityDigest).toBe(createNodeIdentityDigest(node.node.ordinal, node.node.source));
    expect(node.node.source).toMatchObject({ pointer: '/nodes/0' });
    const span = node.node.source.span;
    expect(span).not.toBeNull();
    if (span === null) return;
    expect(source.slice(span.start.utf8ByteOffset, span.end.utf8ByteOffset)).toContain(canaries[0]);
  });

  it('publishes ordinary node identifiers unchanged', () => {
    const result = scanWorkflowV2({
      bytes: bytes(JSON.stringify({ nodes: [{ id: 'http', name: 'Send email', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { url: 'https://other.example/hook' } }], connections: {} })),
      profile, approvedDomains: ['approved.example'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.findings.find(({ subject }) => subject.kind === 'NODE')?.subject;
    expect(node).toMatchObject({ kind: 'NODE', node: { ordinal: 0, explicitId: 'http', name: 'Send email' } });
  });
});

describe('scanWorkflowDormantHardenedV2 internal bridge seam', () => {
  it('exercises dormant hardened capabilities through isolated per-scan registry and accessor', () => {
    const source = bytes('{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}],"connections":{}}');
    const result = scanWorkflowDormantHardenedV2({ bytes: source, profile });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected success');
    expect(result.candidates.length).toBe(4);
    expect(result.byCapability.has('graph-semantics')).toBe(true);
    expect(result.byCapability.has('taint-confidentiality')).toBe(true);
    expect(result.byCapability.has('taint-integrity')).toBe(true);
    expect(result.byCapability.has('agentic-control')).toBe(true);
  });

  it('isolates separate scan calls without sharing contexts or taint outcomes', () => {
    const wf1 = bytes('{"nodes":[{"id":"n1","name":"N1","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}],"connections":{}}');
    const wf2 = bytes('{"nodes":[{"id":"n2","name":"N2","type":"n8n-nodes-base.httpRequest","typeVersion":1,"parameters":{"url":"https://example.com"}}],"connections":{}}');
    const res1 = scanWorkflowDormantHardenedV2({ bytes: wf1, profile });
    const res2 = scanWorkflowDormantHardenedV2({ bytes: wf2, profile });
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    if (!res1.ok || !res2.ok) throw new Error('Expected success');
    expect(res1.context).not.toBe(res2.context);
    expect(res1.context.workflow.nodes[0]?.ref.identityDigest).not.toBe(res2.context.workflow.nodes[0]?.ref.identityDigest);
  });

  it('shares single taint execution across multiple consumers in the same scan', () => {
    const spy = vi.spyOn(producerModule, 'produceScanLocalTaintV1');
    try {
      const source = bytes('{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}],"connections":{}}');
      const result = scanWorkflowDormantHardenedV2({ bytes: source, profile });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected success');
      expect(spy).toHaveBeenCalledTimes(1);
      const conf = result.byCapability.get('taint-confidentiality');
      const integ = result.byCapability.get('taint-integrity');
      expect(conf).toBeDefined();
      expect(integ).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('default scanWorkflowV2 never invokes taint producer', () => {
    const spy = vi.spyOn(producerModule, 'produceScanLocalTaintV1');
    try {
      const source = bytes('{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}],"connections":{}}');
      const result = scanWorkflowV2({ bytes: source, profile });
      expect(result.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates failed legacy taint outcome to its two consumers', () => {
    const spy = vi.spyOn(producerModule, 'produceScanLocalTaintV1').mockReturnValue({
      status: 'FAILED', findings: [], diagnostics: [],
    });
    try {
      const source = bytes('{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}],"connections":{}}');
      const result = scanWorkflowDormantHardenedV2({ bytes: source, profile });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected success');
      const conf = result.byCapability.get('taint-confidentiality');
      const integ = result.byCapability.get('taint-integrity');
      expect(conf?.diagnostics.some((d) => d.code === 'REQUIRED_CAPABILITY_FAILED')).toBe(true);
      expect(integ?.facts.some((d) => d.kind === 'dataflow.coverage.v1')).toBe(true);
      expect(integ?.diagnostics.some((d) => d.code === 'REQUIRED_CAPABILITY_FAILED')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects hardened profile requests to the public scanWorkflowV2 with PROFILE_NOT_ADMITTED', () => {
    const source = bytes('{"nodes":[],"connections":{}}');
    const hardenedRequest = { bytes: source, profile: { id: 'beta-hardened', version: '2.0.0' } };
    const resPublic = scanWorkflowV2(hardenedRequest);
    expect(resPublic.ok).toBe(false);
    if (resPublic.ok) throw new Error('Expected failure');
    expect(resPublic.code).toBe('PROFILE_NOT_ADMITTED');
  });

  it('rejects oversized input with WORKFLOW_TOO_LARGE before enumerating properties or slicing bytes', () => {
    const oversized = new Uint8Array(1024 * 1024);
    let getOwnPropertyNamesCalled = false;
    let sliceCalled = false;
    const originalGetOwnPropertyNames = Object.getOwnPropertyNames;
    const originalSlice = Uint8Array.prototype.slice;

    vi.spyOn(Object, 'getOwnPropertyNames').mockImplementation((val: object) => {
      if (val === oversized) {
        getOwnPropertyNamesCalled = true;
      }
      return originalGetOwnPropertyNames(val);
    });

    vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (this: Uint8Array, ...args: [number?, number?]) {
      if (this === oversized) {
        sliceCalled = true;
      }
      return originalSlice.apply(this, args);
    });

    try {
      const result = scanWorkflowV2({
        bytes: oversized,
        profile: { id: 'beta-default', version: '2.0.0' },
        limits: { maxBytes: 16 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WORKFLOW_TOO_LARGE');
      }
      expect(getOwnPropertyNamesCalled).toBe(false);
      expect(sliceCalled).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
