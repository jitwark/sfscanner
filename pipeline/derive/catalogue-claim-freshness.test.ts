import { describe, expect, it } from 'vitest';
import { classifyCatalogueClaim, isDerivationIdentityCurrent, partitionCatalogueClaims } from './catalogue-claim-freshness';
import { makeEntryWithChart } from '../__fixtures__/make-entry';

const connected = {
  nodes: [
    { id: 'a', name: 'A', type: 'trigger', x: 0, y: 0 },
    { id: 'b', name: 'B', type: 'set', x: 1, y: 0 },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'main' }],
};

const selfLoopWithIsolatedWorkNode = {
  ...connected,
  edges: [{ from: 'a', to: 'a', kind: 'main' }],
};

describe('catalogue claim freshness', () => {
  it('publishes a connected chart and quarantines a disconnected one', () => {
    expect(classifyCatalogueClaim(connected).status).toBe('publishable');
    expect(classifyCatalogueClaim({ ...connected, edges: [], unresolvedEdgeCount: 1 })).toMatchObject({
      status: 'quarantine', reasons: ['GRAPH_INCOMPLETE', expect.any(String)],
    });
  });

  it('quarantines a self-loop that leaves another functional node disconnected', () => {
    expect(classifyCatalogueClaim(selfLoopWithIsolatedWorkNode)).toMatchObject({
      status: 'quarantine', reasons: ['GRAPH_INCOMPLETE', expect.any(String)],
    });
  });

  /**
   * The same id-collision defect fixed in `scripts/lib/catalogue-claim-freshness.mjs`.
   * These two implementations must agree: the pipeline decides what to publish,
   * the gate decides whether publishing was legitimate, and a disagreement
   * produces a gate that can never be satisfied.
   */
  it('resolves nodes by position, so redacted or empty ids do not fake a self-loop', () => {
    for (const collision of ['', 'REDACTED', '[CENSORED]']) {
      const collided = {
        nodes: [
          { id: collision, name: 'Webhook', type: 'n8n-nodes-base.webhook', x: 0, y: 0 },
          { id: collision, name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', x: 1, y: 0 },
        ],
        edges: [{ from: 'Webhook', to: 'AI Agent', kind: 'main' }],
      } as unknown as Parameters<typeof classifyCatalogueClaim>[0];
      expect(classifyCatalogueClaim(collided).status, `id collision on ${JSON.stringify(collision)}`)
        .toBe('publishable');
    }
  });

  it('detects stale or missing derivation identity without guessing', () => {
    const identity = { workflowHash: 'w', graphHash: 'g', scannerVersion: 's', profile: 'beta-default' as const };
    expect(isDerivationIdentityCurrent(identity, identity)).toBe(true);
    expect(isDerivationIdentityCurrent(identity, { ...identity, graphHash: 'changed' })).toBe(false);
    expect(isDerivationIdentityCurrent(undefined, identity)).toBe(false);
  });

  it('partitions entries deterministically and preserves the quarantine reason', () => {
    const items = [
      makeEntryWithChart({ id: 'bad' }, { ...connected, edges: [] }),
      makeEntryWithChart({ id: 'good' }, connected),
    ];
    const result = partitionCatalogueClaims(items);
    expect(result.published.map((item) => item.entry.id)).toEqual(['good']);
    expect(result.quarantined).toEqual([
      { entry: items[0]!.entry, reasons: ['GRAPH_INCOMPLETE', expect.any(String)] },
    ]);
  });
});
