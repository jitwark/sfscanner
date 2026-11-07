import { describe, expect, test } from 'vitest';
import { buildSearchText } from './search-text';
import { makeEntry } from '../__fixtures__/make-entry';

describe('buildSearchText', () => {
  test('indexes structured generated content and removes URLs and secret-like text', () => {
    const entry = makeEntry({
      title: 'Webhook to Slack',
      description: 'legacy https://example.com with token=abcdefghijklmnopqrstuvwxyz123456',
      descriptionContent: {
        headline: 'Send requests to Slack', summary: 'Sends a request to Slack.', outcome: 'A team can read the note.',
        beforeAfter: { before: 'A request arrives.', after: 'A note is posted.' }, exampleScenario: 'Example: imagine a request.',
        howItWorks: ['The webhook starts.'], limitations: ['The file has limits.'], audience: 'A new reader.',
      },
    });
    const text = buildSearchText(entry);
    expect(text.content).toContain('Send requests to Slack');
    expect(text.content).not.toContain('https://');
    expect(text.content).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});
