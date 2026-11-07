import { describe, expect, it } from 'vitest';
import { auditCatalogueClaimFreshness, classifyChart } from './catalogue-claim-freshness.mjs';

const chart = { nodes: [{ id: 'a', type: 'trigger' }, { id: 'b', type: 'set' }], edges: [{ from: 'a', to: 'b' }] };
const selfLoopWithIsolatedWorkNode = {
  ...chart,
  edges: [{ from: 'a', to: 'a' }],
};

describe('catalogue claim freshness release gate', () => {
  it('accepts a valid chart and rejects a stale claim left in a projection', () => {
    expect(classifyChart(chart)).toBe('publishable');
    const result = auditCatalogueClaimFreshness([{ id: 'bad' }], new Map([['bad', { ...chart, edges: [] }]]), undefined, ['bad']);
    expect(result.violations).toEqual(expect.arrayContaining([
      'bad: stale/incomplete catalogue claim remains public',
      'quarantined claim appears in a derived public projection',
      'quarantined claims have no quarantine report',
    ]));
  });

  it('quarantines a self-loop that leaves another functional node disconnected', () => {
    expect(classifyChart(selfLoopWithIsolatedWorkNode)).toBe('quarantine');
  });

  /**
   * Sanitization can collapse every node id in a chart to one value. Three
   * collision tokens appear in the packaged corpus — `''`, `'REDACTED'` and
   * `'[CENSORED]'` — across 18 of 13,221 charts.
   *
   * The classifier used to resolve an edge endpoint to a node *id* and then
   * require `from !== to` to prove two distinct nodes. With colliding ids every
   * edge in a perfectly connected 41-node graph looked like a self-loop, and the
   * workflow was withheld from the catalogue as unrenderable. Identity must come
   * from the node's position, which cannot collide.
   */
  it('resolves nodes by position, so redacted or empty ids do not fake a self-loop', () => {
    for (const collision of ['', 'REDACTED', '[CENSORED]']) {
      const collided = {
        nodes: [
          { id: collision, name: 'Webhook', type: 'n8n-nodes-base.webhook' },
          { id: collision, name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent' },
        ],
        edges: [{ from: 'Webhook', to: 'AI Agent', kind: 'main' }],
      };
      expect(classifyChart(collided), `id collision on ${JSON.stringify(collision)}`).toBe('publishable');
    }
  });

  it('still quarantines a genuine self-loop when ids collide', () => {
    const collided = {
      nodes: [
        { id: 'REDACTED', name: 'Webhook', type: 'n8n-nodes-base.webhook' },
        { id: 'REDACTED', name: 'Orphan', type: 'n8n-nodes-base.set' },
      ],
      edges: [{ from: 'Webhook', to: 'Webhook', kind: 'main' }],
    };
    expect(classifyChart(collided)).toBe('quarantine');
  });

  it('reconciles a quarantined ID outside the public projections', () => {
    const result = auditCatalogueClaimFreshness(
      [{ id: 'good' }], new Map([['good', chart]]),
      { totalInput: 2, published: 1, quarantined: 1, entries: [{ id: 'bad', reasons: ['GRAPH_INCOMPLETE'] }] },
      ['good'],
    );
    expect(result.violations).toEqual([]);
  });

  it('rejects a quarantined report ID leaked into a projection', () => {
    const result = auditCatalogueClaimFreshness(
      [{ id: 'good' }], new Map([['good', chart]]),
      { totalInput: 2, published: 1, quarantined: 1, entries: [{ id: 'bad', reasons: ['GRAPH_INCOMPLETE'] }] },
      ['bad'],
    );
    expect(result.violations).toContain('quarantined claim appears in a derived public projection');
  });

  it('fails closed when the chart identity is missing', () => {
    const result = auditCatalogueClaimFreshness([{ id: 'missing-chart' }], new Map(), undefined);
    expect(result.violations).toContain('missing-chart: stale/incomplete catalogue claim remains public');
  });
});
