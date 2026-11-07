import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TermsPage from '../../../app/terms/page';
import { TermsBody } from './terms-body';

/**
 * Owner policy: accountability is the repository owner's, the claims contact is
 * the configured Gmail, and no governing-law jurisdiction has been supplied —
 * so the terms body names the owner and publishes no jurisdiction claim or
 * placeholder for one.
 *
 * `next/link` is not mocked here, matching the sibling route page tests under
 * `app/app/`, which render it unmocked under jsdom. `JsonLdScript` renders a
 * plain <script> element (or nothing in a preview build), so the route renders
 * unmocked too.
 */

afterEach(cleanup);

/**
 * Concept-level, not phrase-level. This file's earlier literal guards
 * (`'Governing law'`, `/jurisdiction/i`, `'governing law'`) were each shown to
 * pass for `<p>These terms are governed by the laws of the State of
 * Delaware.</p>`. These patterns fail on the concept instead of one phrasing.
 *
 * The two governing phrases allow a short gap — dash, em dash, inline markup,
 * JSX `{' '}` splits — with the same `.{0,16}?` tolerance as
 * `scripts/lib/legal-identity.mjs`, so the rendered test cannot be narrower
 * than the source gate.
 */
const GOVERNING_LAW_CONCEPTS = [
  ['governing law', /governing.{0,16}?laws?\b/i],
  ['governed by', /governed.{0,16}?by\b/i],
  ['jurisdiction', /jurisdiction/i],
  ['venue', /\bvenue\b/i],
  ['courts of', /\bcourts?\s+of\b/i],
] as const;

/**
 * Forms the table must catch. Each is either the phrasing this packet removed
 * or one `A4-REVIEW.md` demonstrated surviving a narrower guard: the hyphen and
 * em-dash forms escaped the earlier `\s+` patterns, which is why the two
 * governing phrases above carry the same short-gap tolerance as
 * `scripts/lib/legal-identity.mjs`.
 */
const MUST_BE_CAUGHT = [
  ['Governing law: Delaware', 'governing law'],
  ['These terms are governed by the laws of the State of Delaware.', 'governed by'],
  ['Governing-law clause: disputes are heard in Delaware.', 'governing law'],
  ['Governing—law of Delaware applies.', 'governing law'],
  ['Governing-law clause: venue lies in Delaware.', 'venue'],
] as const;

function renderedTermsCopy(): string {
  const { container } = render(<TermsBody />);
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function renderedChangesSectionCopy(): string {
  const { container } = render(<TermsBody />);
  const section = container.querySelector('#changes');
  if (!section) throw new Error('the #changes section is missing from the terms body');
  return (section.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function renderedTermsPageCopy(): string {
  const { container } = render(<TermsPage />);
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('TermsBody owner identity', () => {
  it('names the repository owner as the operator', () => {
    expect(renderedTermsCopy()).toContain('jitwark (repository owner)');
  });

  it('publishes the configured contact email', () => {
    expect(renderedTermsCopy()).toContain('voidsyntax01@gmail.com');
  });
});

describe('TermsBody governing-law claims', () => {
  it.each(GOVERNING_LAW_CONCEPTS)('renders no %s claim', (_concept, pattern) => {
    expect(renderedTermsCopy()).not.toMatch(pattern);
  });

  it('renders no unfilled-contact placeholder', () => {
    // `PENDING` itself is never rendered: legal-page.tsx renders
    // `{label} not yet published` for an unfilled ContactValue. Assert that
    // rendered effect instead of the sentinel, which no test can ever see.
    expect(renderedTermsCopy()).not.toContain('not yet published');
  });
});

describe('concept patterns', () => {
  it.each(MUST_BE_CAUGHT)('catches "%s" with the %s concept', (sample, concept) => {
    expect(
      GOVERNING_LAW_CONCEPTS.some(([name, pattern]) => name === concept && pattern.test(sample)),
    ).toBe(true);
  });
});

describe('TermsBody changes section', () => {
  it('stays renamed and still explains how changes are communicated', () => {
    const copy = renderedChangesSectionCopy();
    expect(copy).toContain('Changes to these terms');
    expect(copy).toContain('Superseded versions are kept in the repository rather than deleted');
    expect(copy).toContain('published on this page');
  });

  it('still says how the operator can be reached', () => {
    expect(renderedChangesSectionCopy()).toContain('voidsyntax01@gmail.com');
  });
});

describe('Terms page date', () => {
  it('renders the date of this packet as the last-updated date', () => {
    expect(renderedTermsPageCopy()).toContain('Last updated 2026-10-17');
  });
});
