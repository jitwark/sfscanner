import { describe, expect, it } from 'vitest';
import { buildSemanticVector, cosineSimilarity } from '@hub/contracts';

describe('semantic vectors', () => {
  it('captures intent through aliases instead of exact title overlap', () => {
    const digest = buildSemanticVector({
      title: 'Scheduled email digest', summary: '', tags: '', integrations: 'gmail', trigger: 'Schedule', content: 'send a summary to a team inbox',
    });
    const notification = buildSemanticVector({
      title: 'Notify a team', summary: '', tags: '', integrations: 'slack', trigger: 'Cron', content: 'post a message for the team',
    });
    expect(cosineSimilarity(digest, notification)).toBeGreaterThan(0);
  });

  it('returns deterministic unit vectors', () => {
    const text = { title: 'Webhook', summary: 'Receive an API request', tags: 'http', integrations: 'HTTP Request', trigger: 'Webhook', content: 'parse a request and send a response' };
    const first = buildSemanticVector(text);
    expect(first).toEqual(buildSemanticVector(text));
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
  });
});
