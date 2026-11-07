import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the two files this page's module scope actually reads are faked; every
// other `node:fs` call (jsdom, testing-library, etc.) falls through untouched
// because it never goes through this mocked module. `vi.hoisted` is needed
// because `vi.mock` factories are hoisted above ordinary `const` declarations.
const { fakeReadFileSync } = vi.hoisted(() => {
  const sourcesFixture = [
    { key: 'foo', kind: 'github', repo: 'foo/bar', expectedLicence: 'MIT', status: 'active', reviewedAt: '2026-01-01', note: '' },
  ];
  const statsFixture = { redistributableCount: 1, linkOnlyCount: 0, totalEntries: 1 };
  return {
    fakeReadFileSync: (filePath: string) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      if (normalized.endsWith('pipeline/sources.json')) return JSON.stringify(sourcesFixture);
      if (normalized.endsWith('data/stats.json')) return JSON.stringify(statsFixture);
      throw new Error(`unexpected readFileSync call in test: ${filePath}`);
    },
  };
});

vi.mock('node:fs', () => ({
  readFileSync: fakeReadFileSync,
  default: { readFileSync: fakeReadFileSync },
}));
vi.mock('../../src/seo/json-ld', () => ({
  JsonLdScript: ({ data }: { data: { description?: string } }) => (
    <script data-testid="jsonld">{JSON.stringify(data)}</script>
  ),
  pageJsonLd: (options: unknown) => options,
}));

import SourcesPage from './page';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SourcesPage', () => {
  it('does not promise a per-source workflow count the rendered table does not have', () => {
    render(<SourcesPage />);

    const script = screen.getByTestId('jsonld');
    const data = JSON.parse(script.textContent || '{}');
    expect(data.description).not.toMatch(/workflow count/i);

    // The table's real columns -- no per-source count column exists.
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Source / Repo', 'Kind', 'Licence', 'Status', 'Reviewed', 'Note']);
  });
});
