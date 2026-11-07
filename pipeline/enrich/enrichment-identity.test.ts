import { describe, expect, test } from 'vitest';
import { buildEnrichmentIdentity, isCheckpointCompatible } from './enrichment-identity';

const workflow = {
  name: 'not part of model identity',
  description: 'website prose',
  nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }],
  connections: {},
};

const options = {
  promptText: 'prompt body',
  promptVersion: 'describe-4-gemini-3.7-flash',
  model: 'google-antigravity/gemini-3.7-flash',
};

describe('enrichment identity', () => {
  test('is deterministic and hashes the projected workflow, not website metadata', () => {
    const first = buildEnrichmentIdentity(workflow, options);
    const second = buildEnrichmentIdentity({ ...workflow, description: 'different website prose' }, options);
    expect(first).toEqual(second);
    expect(first.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('accepts an exact identity and rejects legacy or changed identities', () => {
    const identity = buildEnrichmentIdentity(workflow, options);
    expect(isCheckpointCompatible({ identity }, identity)).toBe(true);
    expect(isCheckpointCompatible({}, identity)).toBe(false);
    expect(isCheckpointCompatible({ identity: { ...identity, promptVersion: 'old' } }, identity)).toBe(false);
    expect(isCheckpointCompatible({ identity: { ...identity, model: 'different-model' } }, identity)).toBe(false);
  });
});
