import { describe, expect, it } from 'vitest';
import { composeEntryTitle, stripTrailingSeparators, TERMINAL_SEPARATOR_CHARS } from './entry-title';

/**
 * AUDIT-SEO-001: `truncateWordBoundary` cut a pre-joined title string at 60
 * characters and left whatever character preceded the cut, which was a
 * separator 22.1% of the time across the corpus (2,927 / 13,221 titles).
 * `composeEntryTitle` replaces that with segment composition: the workflow
 * name is mandatory, the qualifier is the richest one that fits alongside it,
 * and the site name is appended only when the whole string still fits.
 */
describe('composeEntryTitle', () => {
  it('composes name + two-integration qualifier + site name when everything fits', () => {
    const title = composeEntryTitle(
      'Email Sync',
      { integrations: ['OpenAI', 'Slack'], trigger: 'Webhook' },
      'n8n-secureflow',
      60,
    );
    expect(title).toBe('Email Sync · n8n workflow (OpenAI, Slack) | n8n-secureflow');
  });

  it('reproduces the kaizenCrypto case: qualifier fits, site name does not', () => {
    const title = composeEntryTitle(
      '{Template} kaizenCrypto',
      { integrations: ['Agent', 'Code'], trigger: 'Manual' },
      'n8n-secureflow',
      60,
    );
    expect(title).toBe('{Template} kaizenCrypto · n8n workflow (Agent, Code)');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
  });

  it('falls back to a single integration when both do not fit', () => {
    const title = composeEntryTitle(
      'Create complete 20-song YouTube playlists with Suno API',
      { integrations: ['Claude', 'Telegram-Bot'], trigger: 'Webhook' },
      'n8n-secureflow',
      60,
    );
    // Name alone is 57 chars, so no parenthesized qualifier of any size fits
    // (57 + " · n8n workflow (X)" always exceeds 60); it must fall back all
    // the way to the bare name with no dangling separator.
    expect(title).toBe('Create complete 20-song YouTube playlists with Suno API');
    expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
  });

  it('falls back to the bare "n8n workflow" label when no parenthesized qualifier fits but the label does', () => {
    const title = composeEntryTitle(
      'Sync Notion with Google Calendar hourly',
      { integrations: ['Notion', 'Google-Calendar'], trigger: 'Schedule' },
      'n8n-secureflow',
      60,
    );
    expect(title).toBe('Sync Notion with Google Calendar hourly · n8n workflow');
    expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
  });

  it('uses trigger as the qualifier when there are no integrations', () => {
    const title = composeEntryTitle('Nightly backup', { integrations: [], trigger: 'Schedule' }, 'n8n-secureflow', 60);
    expect(title).toBe('Nightly backup · n8n workflow (Schedule) | n8n-secureflow');
  });

  it('uses the bare "n8n workflow" qualifier when there is no trigger and no integrations', () => {
    const title = composeEntryTitle('Nightly backup', { integrations: [], trigger: undefined }, 'n8n-secureflow', 60);
    expect(title).toBe('Nightly backup · n8n workflow | n8n-secureflow');
  });

  it('truncates a name that alone exceeds the budget at a word boundary, with no dangling separator', () => {
    const longName = 'This is a very long workflow title that on its own already exceeds the sixty character budget, no doubt about it';
    const title = composeEntryTitle(longName, { integrations: ['A', 'B'], trigger: 'Webhook' }, 'n8n-secureflow', 60);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
    expect(title.endsWith(' ')).toBe(false);
  });

  it('never emits a title ending in a terminal separator, across a battery of edge-case lengths', () => {
    // A name that, character by character, lands the naive truncation right on
    // top of every separator class the audit found: comma, pipe, middot,
    // hyphen, colon, slash.
    const names = [
      'Automate Personalized Cold Email Sequences with GPT-4',
      'Transform Spreadsheet Data into Smart Charts with OpenAI and QuickChart',
      'A: b',
      'A/ b',
      'A- b',
    ];
    for (const name of names) {
      for (const trigger of ['Webhook', undefined]) {
        const title = composeEntryTitle(name, { integrations: ['OpenAI', 'Slack'], trigger }, 'n8n-secureflow', 60);
        expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
      }
    }
  });

  it('does not truncate mid-word when the qualifier is dropped', () => {
    const title = composeEntryTitle(
      'Design scalable sync workflows with Data Tables and ProspectPro',
      { integrations: ['Data-Tables', 'ProspectPro'], trigger: 'Manual' },
      'n8n-secureflow',
      60,
    );
    // Either the full name fits (with or without a qualifier/site suffix), or
    // it was cut at a space — never mid-word, and never on a separator.
    expect(title === 'Design scalable sync workflows with Data Tables and ProspectPro' || !title.match(/\S-$/)).toBe(true);
    expect(TERMINAL_SEPARATOR_CHARS).not.toContain(title.at(-1));
  });

  it('leaves a well-formed short title untouched aside from the qualifier composition', () => {
    const title = composeEntryTitle('Short title', { integrations: [], trigger: undefined }, 'n8n-secureflow', 60);
    expect(title).toBe('Short title · n8n workflow | n8n-secureflow');
  });
});

describe('stripTrailingSeparators', () => {
  it('strips a trailing comma, pipe, middot, hyphen, colon, or slash', () => {
    expect(stripTrailingSeparators('Foo,')).toBe('Foo');
    expect(stripTrailingSeparators('Foo |')).toBe('Foo');
    expect(stripTrailingSeparators('Foo ·')).toBe('Foo');
    expect(stripTrailingSeparators('Foo -')).toBe('Foo');
    expect(stripTrailingSeparators('Foo:')).toBe('Foo');
    expect(stripTrailingSeparators('Foo/')).toBe('Foo');
  });

  it('strips a run of trailing separators and whitespace together', () => {
    expect(stripTrailingSeparators('Foo, · |')).toBe('Foo');
  });

  it('preserves a legitimate closing paren, and internal punctuation of any kind', () => {
    expect(stripTrailingSeparators('Foo (Bar, Baz)')).toBe('Foo (Bar, Baz)');
    expect(stripTrailingSeparators('GPT-4, the sequel')).toBe('GPT-4, the sequel');
  });

  it('does not strip a comma that is not terminal', () => {
    expect(stripTrailingSeparators('A, B, C')).toBe('A, B, C');
  });
});

describe('AUDIT-SEO-001 residual: truncation inside a bracketed clause (R1-F2)', () => {
  // A word-boundary cut can land *inside* `(...)`, leaving the bracket open.
  // 85 of 13,221 corpus titles did this. The terminal-separator rule cannot
  // see it because the last character is an ordinary letter.
  it.each([
    'AI Agent for PetShop Appointments (Agente de IA para agendamentos veterinarios)',
    'WhatsApp expense tracker with multi-input (text, image and voice note capture)',
    'Automate Data Extraction with Zyte AI (Products, Jobs, Articles and Reviews)',
  ])('never leaves an unclosed bracket when the name alone overflows: %s', (name) => {
    const title = composeEntryTitle(name, { integrations: [] }, 'Site');
    const opens = (title.match(/\(/g) ?? []).length;
    const closes = (title.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.trim()).not.toBe('');
  });

  it('drops the dangling clause rather than the whole name', () => {
    const title = composeEntryTitle(
      'WhatsApp expense tracker with multi-input (text, image and voice note capture)',
      { integrations: [] },
      'Site',
    );
    expect(title).toContain('WhatsApp expense tracker');
    expect(title).not.toContain('(');
  });

  // R2-F1: the `stripTrailingSeparators` call inside `composeEntryTitle` was
  // never exercised — every existing fixture happened to truncate onto a
  // letter, so deleting the call at the real call site passed all 29 tests.
  // Sweep a range of overflowing names so the cut lands on a separator.
  it('never ends a truncated name on a separator, across many cut positions', () => {
    const base = 'Sync invoices, receipts, orders, quotes, contracts, and renewals across systems';
    for (let extra = 0; extra < 40; extra += 1) {
      const title = composeEntryTitle(`${'x'.repeat(extra)} ${base}`, { integrations: [] }, 'Site');
      expect(title).not.toMatch(/[,|·\-:/]$/u);
      expect(title).toBe(title.trim());
    }
  });
});
