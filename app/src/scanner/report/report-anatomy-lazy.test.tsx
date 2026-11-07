import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type DynamicCall = {
  loader: () => Promise<unknown>;
  options: { ssr?: boolean; loading?: () => ReactElement | null };
};

const state = vi.hoisted(() => ({
  calls: [] as DynamicCall[],
  sharedLoader: vi.fn(async () => function MockReportExportActions() {
    return null;
  }),
}));

vi.mock('./report-export-actions-loader', () => ({
  loadReportExportActions: state.sharedLoader,
}));

vi.mock('next/dynamic', () => ({
  default: (loader: DynamicCall['loader'], options: DynamicCall['options']) => {
    state.calls.push({ loader, options });
    return function MockDynamic() {
      return null;
    };
  },
}));

import './report-anatomy';

describe('report export boundary', () => {
  it('registers export actions as an accessible client-side lazy boundary', async () => {
    expect(state.calls).toHaveLength(1);

    const boundary = state.calls[0];
    expect(boundary.options).toMatchObject({ ssr: false });
    expect(boundary.options.loading).toBeTypeOf('function');
    expect(boundary.loader).toBe(state.sharedLoader);

    const fallback = boundary.options.loading?.();
    expect(fallback).not.toBeNull();
    render(fallback);
    const loading = screen.getByRole('status', { name: 'Preparing report export actions' });
    expect(loading.className).toContain('min-h-11');

    const loaded = await boundary.loader();
    expect(loaded).toBeTypeOf('function');
  });
});
