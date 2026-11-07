import { describe, expect, it } from 'vitest';
import { entryId, slugify } from './entry-id.js';

describe('entry-id', () => {
  it('produces deterministic 16-hex ids', () => {
    const id1 = entryId('github', 'Zie619/n8n-workflows', 'workflows/slack.json');
    const id2 = entryId('github', 'Zie619/n8n-workflows', 'workflows/slack.json');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[a-f0-9]{16}$/);
  });

  it('changes id if kind, ref, or path changes', () => {
    const base = entryId('github', 'owner/repo', 'a.json');
    expect(entryId('n8n_official', 'owner/repo', 'a.json')).not.toBe(base);
    expect(entryId('github', 'other/repo', 'a.json')).not.toBe(base);
    expect(entryId('github', 'owner/repo', 'b.json')).not.toBe(base);
  });

  it('slugifies title and id cleanly', () => {
    expect(slugify('Slack & Telegram Notifier #1', '1234567890abcdef')).toBe('slack-telegram-notifier-1-12345678');
    expect(slugify('!!!', '1234567890abcdef')).toBe('workflow-12345678');
    expect(slugify('Simple', 'abc')).toBe('simple-abc');
  });
});
