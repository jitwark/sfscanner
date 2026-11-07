import { describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from './index';

type Failure = { ok: false; code: string };
const bytes = (value = '{"nodes":[],"connections":{}}') => new TextEncoder().encode(value);
const webhookBytes = (authentications: readonly string[]) => bytes(JSON.stringify({
  nodes: authentications.map((authentication, index) => ({ id: `w${index}`, name: `Webhook ${index}`, type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { authentication } })),
  connections: {},
}));
const request = (overrides: Record<string, unknown> = {}) => ({
  bytes: bytes(), profile: { id: 'beta-default', version: '2.0.0' }, ...overrides,
});
const failure = (value: unknown): Failure => value as Failure;

describe('scanWorkflowV2', () => {
  it('scans raw bytes through the admitted beta-default profile', () => {
    const result = scanWorkflowV2(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.schemaVersion).toBe('scanner-result-v2');
      expect(result.result.profile).toEqual({ id: 'beta-default', version: '2.0.0' });
      expect(result.result.assessment).not.toBeNull();
      expect(Object.isFrozen(result.result)).toBe(true);
    }
  });
  it('accepts equivalent numeric and decimal string typeVersions through semantic admission', () => {
    const analyses = ([1, '1', '1.0', '1.0.0'] as const).map((typeVersion) => {
      const source = JSON.stringify({ nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion, parameters: {} }], connections: {} });
      const result = scanWorkflowV2(request({ bytes: bytes(source) }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`scan failed: ${result.code}`);
      return result.result.analysis;
    });
    expect(analyses[0]?.status).toBe('COMPLETE');
    for (const analysis of analyses.slice(1)) expect(analysis).toEqual(analyses[0]);
  });
  it.each(['01', '1.01'])('rejects malformed typeVersion string %s', (typeVersion) => {
    const source = JSON.stringify({ nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion, parameters: {} }], connections: {} });
    expect(failure(scanWorkflowV2(request({ bytes: bytes(source) })))).toMatchObject({ code: 'SEMANTIC_CATALOGUE_INVALID' });
  });
  it('keeps an unadmitted prerelease typeVersion out of complete semantic analysis', () => {
    const source = JSON.stringify({ nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: '1.0.0-alpha', parameters: {} }], connections: {} });
    const result = scanWorkflowV2(request({ bytes: bytes(source) }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`scan failed: ${result.code}`);
    expect(result.result.analysis.status).toBe('DEGRADED');
    expect(result.result.analysis.diagnostics.map(({ code }) => code)).toContain('SEMANTIC_CATALOGUE_MISS');
  });

  it('rejects malformed, unknown, and unadmitted profile references before scanning', () => {
    const malformed = scanWorkflowV2({ bytes: bytes(), profile: { id: 'beta-default' } } as unknown);
    const unknownKey = scanWorkflowV2({ bytes: bytes(), profile: { id: 'beta-default', version: '2.0.0', extra: true } } as unknown);
    const hardened = scanWorkflowV2(request({ profile: { id: 'beta-hardened', version: '2.0.0' } }));
    expect(failure(malformed)).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(failure(unknownKey)).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(failure(hardened)).toMatchObject({ code: 'PROFILE_NOT_ADMITTED' });
  });

  it('rejects unsafe bytes and unknown request keys', () => {
    expect(failure(scanWorkflowV2({ ...request(), extra: true } as unknown))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(failure(scanWorkflowV2({ ...request(), bytes: [123] } as unknown))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('honours the operator allowlist when scoring the same workflow bytes', () => {
    const source = bytes('{"nodes":[{"id":"request","name":"Request","type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://unapproved.example/v1/events"}}],"connections":{}}');
    // An allowlist is a live predicate, not a decorative field: the same bytes are flagged when the
    // destination is outside it and clean when it is inside. An absent (or empty) allowlist stays
    // DISABLED, which is v1's `domain-policy.ts` semantics.
    const outside = scanWorkflowV2({ ...request({ bytes: source }), approvedDomains: ['trusted.example'] });
    const inside = scanWorkflowV2({ ...request({ bytes: source }), approvedDomains: ['unapproved.example'] });
    const disabled = scanWorkflowV2(request({ bytes: source }));
    expect(outside.ok).toBe(true);
    expect(inside.ok).toBe(true);
    if (!outside.ok || !inside.ok || !disabled.ok) return;
    expect(outside.result.findings.map(({ ruleId }) => ruleId)).toContain('UNAPPROVED_DOMAIN');
    expect(inside.result.findings.map(({ ruleId }) => ruleId)).not.toContain('UNAPPROVED_DOMAIN');
    expect(disabled.result.findings.map(({ ruleId }) => ruleId)).not.toContain('UNAPPROVED_DOMAIN');
    // The bytes are identical, so the input identity may not move with the operator allowlist.
    expect(inside.result.input).toEqual(outside.result.input);
  });

  it('treats an empty allowlist as absent and rejects malformed allowlists', () => {
    const canonical = request();
    expect(JSON.stringify(scanWorkflowV2({ ...canonical, approvedDomains: [] }))).toBe(JSON.stringify(scanWorkflowV2(canonical)));
    const sparse: string[] = [];
    sparse[1] = 'unapproved.example';
    for (const malformed of ['unapproved.example', [1], [{}], sparse, { 0: 'unapproved.example' }]) {
      expect(failure(scanWorkflowV2({ ...canonical, approvedDomains: malformed }))).toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  it('resolves omitted target and limits deterministically', () => {
    const result = scanWorkflowV2(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.target.edition).toBe('UNKNOWN');
      expect(result.result.limits.schemaVersion).toBe('scanner-limits-v2');
      expect(result.result.limits.usage.every((item) => Object.keys(item).sort().join(',') === 'examined,exhausted,id,maximum,omitted')).toBe(true);
    }
  });

  it('is byte-identical for repeated scans and rejects forged target descriptors', () => {
    const first = scanWorkflowV2(request());
    const second = scanWorkflowV2(request());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const forged = { ...request(), target: new Proxy({ edition: 'UNKNOWN' }, { getOwnPropertyDescriptor() { throw new Error('must not inspect'); } }) };
    expect(failure(scanWorkflowV2(forged as unknown))).toMatchObject({ code: 'INVALID_CONFIG' });
  });
  it('rejects wrong profile versions and invalid limits', () => {
    expect(failure(scanWorkflowV2(request({ profile: { id: 'beta-default', version: '1.0.0' } }))).code).toBe('PROFILE_NOT_ADMITTED');
    expect(failure(scanWorkflowV2(request({ limits: { maxBytes: -1 } }))).code).toBe('INVALID_CONFIG');
  });
  it('rejects a target context digest mismatch as invalid config', () => {
    const target = {
      edition: 'COMMUNITY',
      deployment: 'SELF_HOSTED',
      role: 'OWNER',
      taskRunner: 'NATIVE',
      communityPackages: [],
      configuration: [],
      contextDigest: '0'.repeat(64),
    };
    expect(failure(scanWorkflowV2(request({ target })))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('rejects unknown target configuration keys explicitly', () => {
    const target = { schemaVersion: 'scanner-target-v3', configuration: [{ key: 'allowShell', state: 'ENABLED' }] };
    expect(failure(scanWorkflowV2(request({ target })))).toMatchObject({ code: 'UNKNOWN_CONFIGURATION_KEY' });
  });

  it('grades a normalized uncatalogued namespaced node under the degraded fallback advisory', () => {
    const source = JSON.stringify({
      nodes: [{ id: 'custom', name: 'Custom', type: '@example/custom-node.unknown', parameters: {} }],
      connections: {},
    });
    const result = scanWorkflowV2(request({ bytes: bytes(source) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.workflow.nodeCount).toBe(1);
      expect(result.result.analysis.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'DEGRADED', assessmentEligible: true, location: expect.objectContaining({ pointer: '/nodes/0' }) }),
      ]));
      expect(result.result.analysis.status).toBe('DEGRADED');
      expect(result.result.assessment).not.toBeNull();
    }
  });

  it('grades a workflow whose finding-bearing node carries an astral character in its name', () => {
    const workflow = (name: string) => bytes(JSON.stringify({ nodes: [{ id: 'h1', name, type: 'n8n-nodes-base.code', typeVersion: 1, parameters: { jsCode: 'eval(userInput)' } }], connections: {} }));
    const control = scanWorkflowV2(request({ bytes: workflow('Call Code') }));
    const astral = scanWorkflowV2(request({ bytes: workflow('🙂') }));
    expect(control.ok && astral.ok).toBe(true);
    if (!control.ok || !astral.ok) return;
    // The name is display text: it must not move the verdict, and it must not cost the finding.
    expect(astral.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`)).toEqual(control.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`));
    expect(control.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`)).toEqual(['N8N_CODE_NODE:LOW']);
    expect(astral.result.findings[0]?.subject).toMatchObject({ kind: 'NODE', node: { name: '🙂' } });
    expect(astral.result.analysis.capabilities.map(({ status }) => status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(astral.result.analysis.diagnostics).toEqual([]);
    expect(astral.result.analysis.status).toBe('COMPLETE');
    // The name is part of the finding's identity digest, so only the verdict itself can be compared.
    expect([astral.result.assessment?.grade, astral.result.assessment?.score]).toEqual([control.result.assessment?.grade, control.result.assessment?.score]);
    expect(astral.result.assessment?.grade).toBe('LOW');
  });

  it('keeps a secret finding at its severity when the node name is astral', () => {
    const workflow = (name: string) => bytes(JSON.stringify({ nodes: [{ id: 'h1', name, type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { apiKey: 'sk_live_super_secret_value' } }], connections: {} }));
    const control = scanWorkflowV2(request({ bytes: workflow('Call API') }));
    const astral = scanWorkflowV2(request({ bytes: workflow('🙂') }));
    expect(control.ok && astral.ok).toBe(true);
    if (!control.ok || !astral.ok) return;
    expect(control.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`)).toEqual(['RAW_SECRET_INDICATOR:HIGH']);
    expect(astral.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`)).toEqual(control.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`));
    expect(astral.result.analysis.status).toBe('COMPLETE');
    expect(astral.result.assessment?.grade).toBe(control.result.assessment?.grade);
  });

  it('rejects non-plain and non-enumerable request records', () => {
    const inherited = Object.assign(Object.create({}), request());
    const nonEnumerable = request();
    Object.defineProperty(nonEnumerable, 'bytes', { value: nonEnumerable.bytes, enumerable: false });
    expect(failure(scanWorkflowV2(inherited as unknown))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(failure(scanWorkflowV2(nonEnumerable as unknown))).toMatchObject({ code: 'INVALID_CONFIG' });
  });


  it('reports webhook exposure for whitespace and CRLF authentication spellings', () => {
    // The v1 policy refuses every spelling except the exact three raw names, so these four nodes
    // already produce WEBHOOK_EXPOSURE. The v2 consumer must keep those findings: its ingress fact
    // quarantines a malformed namespaced value before the fact ID is recomputed, so the producer and
    // the validator have to canonicalise identically (65-F1).
    const result = scanWorkflowV2(request({ bytes: webhookBytes([' basicAuth ', 'basicAuth ', 'jwtAuth\r\n', 'basicAuth\t']) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.findings.map(({ ruleId, severity }) => `${ruleId}:${severity}`)).toEqual([
      'WEBHOOK_EXPOSURE:MEDIUM', 'WEBHOOK_EXPOSURE:MEDIUM', 'WEBHOOK_EXPOSURE:MEDIUM', 'WEBHOOK_EXPOSURE:MEDIUM',
    ]);
    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(result.result.analysis.diagnostics.map(({ code }) => code)).not.toContain('REQUIRED_CAPABILITY_FAILED');
    expect(result.result.analysis.diagnostics.map(({ code }) => code)).not.toContain('DEPENDENCY_UNAVAILABLE');
  });

  it('protects the exact authentication names and still reports every other spelling', () => {
    const exact = scanWorkflowV2(request({ bytes: webhookBytes(['basicAuth', 'headerAuth', 'jwtAuth']) }));
    const other = scanWorkflowV2(request({ bytes: webhookBytes(['BASICAUTH', 'oauth2', 'unknown']) }));
    expect(exact.ok && other.ok).toBe(true);
    if (!exact.ok || !other.ok) return;
    expect(exact.result.findings).toEqual([]);
    expect(exact.result.analysis.status).toBe('COMPLETE');
    expect(other.result.findings.map(({ ruleId }) => ruleId)).toEqual(['WEBHOOK_EXPOSURE', 'WEBHOOK_EXPOSURE', 'WEBHOOK_EXPOSURE']);
    expect(other.result.analysis.status).toBe('COMPLETE');
  });

  it('does not read clock or network during a scan', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network'); });
    try { expect(scanWorkflowV2(request()).ok).toBe(true); } finally { clock.mockRestore(); fetch.mockRestore(); }
  });
});
