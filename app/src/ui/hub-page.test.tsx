import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubInfo } from '../catalogue/hub-types';
import { HubPage } from './hub-page';

const hub: HubInfo = {
  kind: 'tag',
  slug: 'notifications',
  title: 'Notifications',
  entryIds: [],
  totalEntries: 48,
  totalPages: 2,
  companionIntegrations: [],
  companionTags: [],
  dominantTrigger: 'manual',
  gradeSpread: { low: 48, medium: 0, high: 0, critical: 0, unknown: 0 },
  introCopy: 'This hub contains 48 workflows.',
};

describe('HubPage', () => {
  afterEach(() => cleanup());

  it('reports the visible count when the static hub slice is incomplete', () => {
    render(
      <HubPage
        kind="tag"
        hub={hub}
        entries={[]}
        basePath="/tags/notifications/"
        page={1}
        showPagination={false}
      />,
    );

    expect(screen.getByText(/Showing 0 of 48 quality-ranked workflows/)).toBeTruthy();
    expect(screen.queryByText(/Showing the first 0 quality-ranked workflows/)).toBeNull();
  });
});
