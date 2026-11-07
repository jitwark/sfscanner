import { describe, expect, it } from 'vitest';
import { deriveCompatibility } from './compatibility';

const target = { targetVersion: '2.34.6', checkedAt: '2026-08-16', source: 'test snapshot' };

describe('deriveCompatibility', () => {
  it('marks pinned core nodes likely compatible with the target snapshot', () => {
    const result = deriveCompatibility({ nodes: [
      { type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
      { type: 'n8n-nodes-base.slack', typeVersion: 2, parameters: {} },
    ] }, target);
    expect(result.status).toBe('likely-compatible');
    expect(result.targetVersion).toBe('2.34.6');
  });

  it('requires review for legacy nodes, expressions, and community packages', () => {
    const result = deriveCompatibility({ nodes: [
      { type: 'n8n-nodes-base.function', parameters: { code: 'return $node["A"]' } },
      { type: 'community.nodes.custom', typeVersion: 1, parameters: {} },
    ] }, target);
    expect(result.status).toBe('review-required');
    expect(result.blockers.join(' ')).toMatch(/legacy Function|community node|\$node/);
  });

  it('returns unknown for malformed workflow JSON', () => {
    expect(deriveCompatibility({}, target).status).toBe('unknown');
  });
});
