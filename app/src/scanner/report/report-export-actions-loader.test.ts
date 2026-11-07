import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  moduleLoads: vi.fn(),
}));

vi.mock('./report-export-actions', () => {
  state.moduleLoads();
  return { ReportExportActions: function ReportExportActions() { return null; } };
});

import { loadReportExportActions, preloadReportExportActions } from './report-export-actions-loader';

beforeEach(() => {
  state.moduleLoads.mockClear();
});

describe('report export actions loader', () => {
  it('serves preload and component loading from one dynamic module promise', async () => {
    preloadReportExportActions();
    const first = await loadReportExportActions();
    const second = await loadReportExportActions();

    expect(first).toBe(second);
    expect(state.moduleLoads).toHaveBeenCalledTimes(1);
  });
});
