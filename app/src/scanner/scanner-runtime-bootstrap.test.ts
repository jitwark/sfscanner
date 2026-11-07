import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prepareWorker: vi.fn(),
  resultModuleLoaded: vi.fn(),
  preloadReportExportActions: vi.fn(),
}));

vi.mock('./scanner-v2-adapter', () => ({
  prepareBrowserScanV2: state.prepareWorker,
}));

vi.mock('./report/report-result', () => {
  state.resultModuleLoaded();
  return { ReportResult: () => null };
});

vi.mock('./report/report-export-actions-loader', () => ({
  preloadReportExportActions: state.preloadReportExportActions,
}));

let prepareScannerRuntime: typeof import('./scanner-runtime-bootstrap')['prepareScannerRuntime'];

beforeEach(async () => {
  state.prepareWorker.mockClear();
  state.resultModuleLoaded.mockClear();
  state.preloadReportExportActions.mockClear();
  vi.stubGlobal('Worker', class {});
  vi.resetModules();
  ({ prepareScannerRuntime } = await import('./scanner-runtime-bootstrap'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scanner runtime bootstrap', () => {
  it('starts the real worker and preloads every required report chunk without scanning', async () => {
    prepareScannerRuntime();

    expect(state.prepareWorker).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(state.resultModuleLoaded).toHaveBeenCalledTimes(1));
    expect(state.preloadReportExportActions).toHaveBeenCalledTimes(1);
  });

  it('does nothing during server evaluation', () => {
    vi.unstubAllGlobals();

    prepareScannerRuntime();

    expect(state.prepareWorker).not.toHaveBeenCalled();
    expect(state.resultModuleLoaded).not.toHaveBeenCalled();
    expect(state.preloadReportExportActions).not.toHaveBeenCalled();
  });
});
