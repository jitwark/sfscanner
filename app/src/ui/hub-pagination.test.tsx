import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HubPagination } from './hub-pagination';

describe('HubPagination', () => {
  afterEach(() => cleanup());

  it('does not link to pages that are intentionally outside the static export', () => {
    render(<HubPagination basePath="/tags/simple/" currentPage={1} totalPages={8} />);

    expect(screen.queryByRole('link', { name: '6' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });
});
