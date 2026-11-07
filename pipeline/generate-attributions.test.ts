import { describe, expect, it } from 'vitest';
import { makeEntry } from './__fixtures__/make-entry.js';
import { renderAttributions } from './generate-attributions.js';

const entries = [
  makeEntry({ source: { kind: 'github', repo: 'owner/repo' } }),
  makeEntry({ id: 'official', source: { kind: 'n8n_official' } }),
  makeEntry({ id: 'excluded-entry', source: { kind: 'github', repo: 'ignored/repo' } }),
];

const sources = [
  { key: 'repo', kind: 'github' as const, repo: 'owner/repo', expectedLicence: 'MIT', status: 'active' as const },
  { key: 'official', kind: 'n8n_official' as const, expectedLicence: null, status: 'active' as const },
  { key: 'excluded', kind: 'github' as const, repo: 'ignored/repo', expectedLicence: 'MIT', status: 'excluded' as const },
];

describe('renderAttributions', () => {
  it('lists every active source with its canonical primary-entry count', () => {
    const output = renderAttributions(sources, entries);

    expect(output).toContain('| [owner/repo](https://github.com/owner/repo) | MIT | 1 |');
    expect(output).toContain('| [Official n8n templates](https://n8n.io/workflows/) | No asserted licence | 1 |');
    expect(output).toContain('Active-source canonical entries: 2.');
  });

  it('keeps an excluded source in an explicit retained-credit section and totals it', () => {
    const output = renderAttributions(sources, entries);
    const excludedSection = output.slice(output.indexOf('## Excluded sources with retained credit'));

    expect(excludedSection).toContain('| [ignored/repo](https://github.com/ignored/repo) | MIT | 1 |');
    expect(output).toContain('Excluded-source canonical entries with retained credit: 1.');
    expect(output).toContain('Total canonical entries: 3.');
  });

  it('states the public acquisition count on its own basis', () => {
    const output = renderAttributions(sources, entries);

    expect(output).toContain('Public-tree acquisition entries: 13,221.');
    expect(output).toContain('not summed with the canonical total');
    expect(output).toContain('CC BY-SA 4.0');
    expect(output).toContain('unresolved, public-only extraction defect');
  });

  it('renders an empty retained-credit row rather than dropping the section', () => {
    const output = renderAttributions([sources[0]!, sources[1]!], entries);

    expect(output).toContain('## Excluded sources with retained credit');
    expect(output).toContain('| — | — | 0 |');
    expect(output).toContain('Excluded-source canonical entries with retained credit: 0.');
  });
});
