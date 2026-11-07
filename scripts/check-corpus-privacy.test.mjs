import { describe, expect, test } from 'vitest';
import { MATCHERS, sweepCorpusPrivacy } from './lib/corpus-privacy.mjs';

/**
 * The corpus republishes other people's prose. The sanitizer redacts what it
 * recognises at acquisition; nothing has measured what survives into the
 * artifacts. This sweep counts, and deliberately never returns a value — a
 * privacy check that prints the email addresses it found has published them a
 * second time, into CI logs retained for weeks.
 */
describe('sweepCorpusPrivacy', () => {
  test('counts a seeded email, token, private IP and internal hostname', () => {
    const { totals } = sweepCorpusPrivacy([
      { id: 'a', text: 'contact jane.doe@acme.co.uk for access' },
      { id: 'b', text: 'header: Bearer abcdef0123456789abcdef' },
      { id: 'c', text: 'the box at 10.0.42.7 runs the worker' },
      { id: 'd', text: 'posts to jenkins.internal every hour' },
    ]);

    expect(totals['email-address']).toBe(1);
    expect(totals['bearer-or-api-key']).toBe(1);
    expect(totals['private-ip']).toBe(1);
    expect(totals['internal-hostname']).toBe(1);
  });

  test('never returns a matched value, only counts and entry ids', () => {
    const result = sweepCorpusPrivacy([{ id: 'a', text: 'jane.doe@acme.co.uk' }]);
    expect(JSON.stringify(result)).not.toContain('jane.doe');
    expect(result.entriesAffected['email-address']).toEqual(['a']);
  });

  test('ignores placeholders, which are most of what workflow prose contains', () => {
    const { totals } = sweepCorpusPrivacy([
      { id: 'a', text: 'set it to you@example.com or user@domain.com' },
      { id: 'b', text: 'use `Bearer {{ $credentials.token }}` in the header' },
      { id: 'c', text: 'replace <YOUR_EMAIL> with your address' },
    ]);

    expect(totals['email-address']).toBe(0);
    expect(totals['bearer-or-api-key']).toBe(0);
  });

  test('does not count a filename as an address', () => {
    // Workflow prose is full of them: `invoice.summary@report.pdf` is a file,
    // not a person, and counting it makes the number mean nothing.
    const { totals } = sweepCorpusPrivacy([
      { id: 'a', text: 'names the document invoice_march.summary@drive.pdf and uploads it' },
    ]);
    expect(totals['email-address']).toBe(0);
  });

  test('counts every occurrence but lists an entry once', () => {
    const result = sweepCorpusPrivacy([
      { id: 'a', text: 'ping 10.0.0.1 then 192.168.1.9 then 172.16.4.4' },
    ]);
    expect(result.totals['private-ip']).toBe(3);
    expect(result.entriesAffected['private-ip']).toEqual(['a']);
  });

  test('a clean corpus reports zero for every shape', () => {
    const result = sweepCorpusPrivacy([{ id: 'a', text: 'A schedule trigger posts to Slack.' }]);
    for (const matcher of MATCHERS) expect(result.totals[matcher.name]).toBe(0);
    expect(result.scanned).toBe(1);
  });

  test('tolerates an entry with no text without counting it as clean by accident', () => {
    const result = sweepCorpusPrivacy([{ id: 'a', text: undefined }, { id: 'b', text: '' }]);
    expect(result.scanned).toBe(2);
    expect(result.totals['email-address']).toBe(0);
  });

  test('every matcher is bounded, because it reads untrusted text', () => {
    // A pattern with unbounded overlapping repetition turns a published
    // description into a denial of service. `check:regex-safety` enforces this
    // across the scanner; these read the same untrusted corpus.
    for (const matcher of MATCHERS) {
      expect(matcher.pattern.source).not.toMatch(/\([^)]*[+*]\)[+*]/);
      const hostile = `${'a'.repeat(50_000)}!`;
      const started = Date.now();
      matcher.pattern.lastIndex = 0;
      [...hostile.matchAll(matcher.pattern)];
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});
