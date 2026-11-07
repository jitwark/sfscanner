import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Entry } from '@hub/contracts';
import { AboutSection } from './about-section';

afterEach(() => cleanup());

const MOCK_ENTRY: Entry = {
  id: 'test-about',
  slug: 'test-about',
  title: 'Sample Workflow',
  summary: 'Sample summary',
  description: 'This is the upstream description of the workflow.',
  descriptionSource: 'upstream',
  security: { grade: 'A', score: 95, findings: [], scannerVersion: '1', profile: 'p', counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
  source: { kind: 'community_repo', fetchedAt: '2026-08-01T00:00:00Z', permalink: 'https://example.com' },
  rights: { status: 'redistributable', licence: 'MIT', reason: 'MIT' },
  structure: { nodeCount: 5, rawNodeCount: 5, annotationNodeCount: 0, connectionCount: 4, complexity: 'low', integrations: [] },
} as unknown as Entry;

describe('AboutSection', () => {
  it('renders upstream description and heading', () => {
    render(<AboutSection entry={MOCK_ENTRY} />);
    expect(screen.getByText('About this workflow')).toBeTruthy();
    expect(screen.getByText(/This is the upstream description/i)).toBeTruthy();
  });

  it('renders fallback when unpublishable', () => {
    const unpub = { ...MOCK_ENTRY, descriptionSource: 'unverified' } as unknown as Entry;
    render(<AboutSection entry={unpub} />);
    expect(screen.getByText(/A publishable description is not available/i)).toBeTruthy();
  });
});
