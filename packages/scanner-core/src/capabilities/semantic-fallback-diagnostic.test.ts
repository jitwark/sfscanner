import { describe, expect, it } from 'vitest';
import { scanWorkflowV2, type ScanWorkflowV2Result } from '../v2';

const encoder = new TextEncoder();
const profile = { id: 'beta-default', version: '2.0.0' } as const;
type Result = Extract<ScanWorkflowV2Result, { ok: true }>['result'];
type Node = Record<string, unknown>;

const node = (id: string, type: string, parameters: unknown, extra: Node = {}): Node =>
  ({ id, name: id, type, typeVersion: 1, parameters, ...extra });
const source = (nodes: readonly Node[], connections: unknown = {}) => JSON.stringify({ nodes, connections });
const chain = (nodes: readonly Node[]) => source(nodes, {
  Start: { main: [[{ node: String(nodes[1]?.id ?? ''), type: 'main', index: 0 }]] },
});
const scan = (document: string, overrides: Record<string, unknown> = {}): Result => {
  const result = scanWorkflowV2({ bytes: encoder.encode(document), profile, ...overrides });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.result;
};
const codesAt = (result: Result, pointer: string) =>
  result.analysis.diagnostics.filter(({ location }) => location?.pointer === pointer).map(({ code }) => code);

const START = node('Start', 'n8n-nodes-base.manualTrigger', {});
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
// D-01 models googleSheets, so the fallback cases use a type that stays unmodelled.
const UNKNOWN = node('Unknown', 'n8n-nodes-base.discord', {
  url: 'https://example.invalid/x',
  awsSecretAccessKey: SECRET,
});

describe('generic fallback coverage diagnostics', () => {
  it('emits both coverage codes per unmodelled node, retains the finding, and grades', () => {
    const result = scan(chain([START, UNKNOWN]));

    expect(codesAt(result, '/nodes/1')).toEqual([
      'SEMANTIC_CATALOGUE_MISS',
      'GENERIC_NODE_UNMODELED_CAPABILITY',
    ]);
    for (const code of ['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']) {
      expect(result.analysis.diagnostics).toContainEqual(expect.objectContaining({
        code, aggregateEffect: 'DEGRADED', assessmentEligible: true,
        location: expect.objectContaining({ pointer: '/nodes/1' }),
      }));
    }
    expect(result.analysis.status).toBe('DEGRADED');
    expect(result.assessment).not.toBeNull();
    expect(result.findings.map(({ ruleId }) => ruleId)).toContain('RAW_SECRET_INDICATOR');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('retains known-node findings in a mixed workflow', () => {
    const request = node('Request', 'n8n-nodes-base.httpRequest', { url: 'https://evil.example.com/x', method: 'GET' });
    const result = scan(source([START, request, UNKNOWN], {
      Start: { main: [[{ node: 'Request', type: 'main', index: 0 }], [{ node: 'Unknown', type: 'main', index: 0 }]] },
    }), { approvedDomains: ['trusted.example'] });

    expect(result.findings.map(({ ruleId }) => ruleId))
      .toEqual(expect.arrayContaining(['UNAPPROVED_DOMAIN', 'RAW_SECRET_INDICATOR']));
    // Coverage diagnostics exist only for the unknown node; the known node contributes none.
    expect(result.analysis.diagnostics.filter(({ location }) => location?.pointer === '/nodes/1')).toEqual([]);
    expect(codesAt(result, '/nodes/2')).toEqual([
      'SEMANTIC_CATALOGUE_MISS',
      'GENERIC_NODE_UNMODELED_CAPABILITY',
    ]);
    expect(result.analysis.status).toBe('DEGRADED');
    expect(result.assessment).not.toBeNull();
  });

  it('keeps an unreadable node fail-closed with no capability code', () => {
    const broken = source([START, node('Broken', 'n8n-nodes-base.discord', 'not-an-object')]);
    const result = scan(broken);

    expect(result.analysis.status).toBe('INDETERMINATE');
    expect(result.assessment).toBeNull();
    expect(result.analysis.diagnostics.map(({ code }) => code).sort()).toEqual([
      'MALFORMED_NODE_PARAMETERS',
      'SEMANTIC_CATALOGUE_MISS',
    ]);
    expect(result.analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SEMANTIC_CATALOGUE_MISS', aggregateEffect: 'INDETERMINATE', assessmentEligible: false }),
    );
  });

  it('is deterministic across identical scans', () => {
    const first = scan(chain([START, UNKNOWN]));
    const second = scan(chain([START, UNKNOWN]));

    expect(second.analysis).toEqual(first.analysis);
    expect(second.assessment).toEqual(first.assessment);
  });

  it('does not regress a fully catalogued workflow', () => {
    const request = node('Request', 'n8n-nodes-base.httpRequest', { url: 'https://trusted.example/data', method: 'GET' });
    const result = scan(chain([START, request]), { approvedDomains: ['trusted.example'] });

    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.assessment).not.toBeNull();
  });

  it('treats a D-01-modelled googleSheets node as catalogue, not fallback', () => {
    const sheets = node('Sheets', 'n8n-nodes-base.googleSheets', { spreadsheetId: '1AbC' });
    const result = scan(chain([START, sheets]));

    expect(codesAt(result, '/nodes/1')).toEqual([]);
    expect(result.analysis.status).toBe('COMPLETE');
  });
});
