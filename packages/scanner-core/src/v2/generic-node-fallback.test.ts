import { describe, expect, it } from 'vitest';
import { scanWorkflowV2, type ScanWorkflowV2Result } from './index';

/**
 * Owner release fix: an unmodelled node must be scanned under a conservative generic fallback
 * instead of withholding the verdict. A readable fallback node emits both degraded coverage codes
 * (`SEMANTIC_CATALOGUE_MISS` and `GENERIC_NODE_UNMODELED_CAPABILITY`); the v2 report renders them in
 * its Coverage diagnostics section as `CODE · DEGRADED`.
 */
type Result = Extract<ScanWorkflowV2Result, { ok: true }>['result'];
type Node = Record<string, unknown>;

const encoder = new TextEncoder();
const PROFILE = { id: 'beta-default', version: '2.0.0' } as const;
const scan = (workflow: string, overrides: Record<string, unknown> = {}): Result => {
  const result = scanWorkflowV2({ bytes: encoder.encode(workflow), profile: PROFILE, ...overrides });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`scan failed: ${result.code}`);
  return result.result;
};
const node = (id: string, type: string, parameters: unknown, extra: Node = {}): Node => ({ id, name: id, type, typeVersion: 1, parameters, ...extra });
const source = (nodes: readonly Node[], connections: unknown = {}) => JSON.stringify({ nodes, connections });
const escalates = (input: readonly Node[]) => ({ Start: { main: [[{ node: String(input[1]?.id ?? ''), type: 'main', index: 0 }]] } });
const misses = (result: Result) => result.analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS');
const coverage = (result: Result) => result.analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS' || code === 'GENERIC_NODE_UNMODELED_CAPABILITY').map(({ code }) => code);
const rules = (result: Result) => result.findings.map(({ ruleId }) => ruleId);

const START = node('Start', 'n8n-nodes-base.manualTrigger', {});

describe('generic node semantic fallback', () => {
  it('grades a workflow whose only node family is unmodelled, and still reports its AWS secret', () => {
    const unknown = node('Unknown', 'n8n-nodes-base.discord', {
      authentication: 'oAuth2',
      spreadsheetId: '1AbC',
      options: { awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    });
    const result = scan(source([START, unknown], escalates([START, unknown])));

    expect(coverage(result)).toEqual(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']);
    expect(result.analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'DEGRADED', assessmentEligible: true, location: expect.objectContaining({ pointer: '/nodes/1' }) }),
    );
    expect(result.analysis.status).not.toBe('INDETERMINATE');
    expect(result.assessment).not.toBeNull();
    expect(rules(result)).toContain('RAW_SECRET_INDICATOR');
    const secret = result.findings.find(({ ruleId }) => ruleId === 'RAW_SECRET_INDICATOR');
    expect(secret).toMatchObject({ severity: 'HIGH', evidenceClass: 'CONFIGURATION', conclusion: 'OBSERVED' });
  });

  it('audits every property of an unmodelled node, including code-shaped parameters', () => {
    const custom = node('Custom', 'n8n-nodes-base.unmodelledTransform', {
      mode: 'runOnceForAllItems',
      jsCode: 'return items;',
      authentication: { apiKey: 'AKIAIOSFODNN7EXAMPLE' },
    });
    const result = scan(source([START, custom], escalates([START, custom])));

    expect(coverage(result)).toEqual(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']);
    expect(result.assessment).not.toBeNull();
    expect(rules(result)).toContain('RAW_SECRET_INDICATOR');
    expect(result.findings.find(({ ruleId }) => ruleId === 'RAW_SECRET_INDICATOR')?.subject).toMatchObject({ kind: 'NODE', node: expect.objectContaining({ explicitId: 'Custom' }) });
  });

  it('keeps the approved-domain audit live for an unmodelled node and grades the result', () => {
    const custom = node('Custom', 'n8n-nodes-base.unmodelledPoster', { url: 'https://evil.example.com/exfil' });
    const result = scan(source([START, custom], escalates([START, custom])), { approvedDomains: ['trusted.example'] });

    expect(coverage(result)).toEqual(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']);
    expect(rules(result)).toContain('UNAPPROVED_DOMAIN');
    expect(result.assessment).not.toBeNull();
  });

  it('leaves a node whose parameters are genuinely unreadable fail-closed', () => {
    const unreadable = '{"nodes":[{"id":"Start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}},'
      + '{"id":"Broken","name":"Broken","type":"n8n-nodes-base.discord","typeVersion":1,"parameters":"not-an-object"}],"connections":{}}';
    const result = scan(unreadable);

    expect(result.analysis.status).toBe('INDETERMINATE');
    expect(result.assessment).toBeNull();
    expect(misses(result)).toEqual([
      expect.objectContaining({ aggregateEffect: 'INDETERMINATE', assessmentEligible: false, location: expect.objectContaining({ pointer: '/nodes/1' }) }),
    ]);
  });

  it('leaves a node with duplicate parameter members fail-closed', () => {
    const duplicated = '{"nodes":[{"id":"Broken","name":"Broken","type":"n8n-nodes-base.discord","typeVersion":1,"parameters":{},"parameters":{"apiKey":"x"}}],"connections":{}}';
    const result = scan(duplicated);

    expect(result.analysis.status).toBe('INDETERMINATE');
    expect(result.assessment).toBeNull();
    expect(misses(result)).toEqual([expect.objectContaining({ aggregateEffect: 'INDETERMINATE', assessmentEligible: false })]);
  });

  it('leaves a node whose type member is unreadable fail-closed at the scan boundary', () => {
    const duplicatedType = '{"nodes":[{"id":"Broken","name":"Broken","type":"n8n-nodes-base.discord","type":"n8n-nodes-base.discord","typeVersion":1,"parameters":{}}],"connections":{}}';
    const result = scanWorkflowV2({ bytes: encoder.encode(duplicatedType), profile: PROFILE });

    expect(result).toMatchObject({ ok: false, code: 'SEMANTIC_CATALOGUE_INVALID' });
  });

  it('leaves duplicate keys inside parameters fail-closed', () => {
    const duplicatedKeys = '{"nodes":[{"id":"Dup","name":"Dup","type":"n8n-nodes-base.discord","typeVersion":1,"parameters":{"apiKey":"x","apiKey":"y"}}],"connections":{}}';
    const result = scan(duplicatedKeys);

    expect(result.analysis.status).toBe('INDETERMINATE');
    expect(result.assessment).toBeNull();
    expect(result.analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_SECURITY_KEY', aggregateEffect: 'INDETERMINATE', assessmentEligible: false }));
  });

  it('does not touch the modelled path', () => {
    const request = node('Request', 'n8n-nodes-base.httpRequest', { url: 'https://trusted.example/data', method: 'GET' });
    const result = scan(source([START, request], escalates([START, request])), { approvedDomains: ['trusted.example'] });

    expect(misses(result)).toEqual([]);
    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.assessment).not.toBeNull();
    expect(rules(result)).toEqual([]);
  });
});
