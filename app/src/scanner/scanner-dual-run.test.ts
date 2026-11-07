import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBrowserScanV2 } from './scanner-v2-adapter';
import { MockWorker } from './run-scan.test-support';
import { toScannerReportModelV2 } from './scanner-v2-presentation';
import { runScan } from './run-scan';

vi.mock('./scanner-v2-adapter', () => ({ runBrowserScanV2: vi.fn() }));
vi.mock('./scanner-v2-presentation', () => ({ toScannerReportModelV2: vi.fn() }));

const modeKey = '__SECUREFLOW_BROWSER_SCANNER_MODE__';

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[modeKey];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('browser scanner admission', () => {
  it('keeps the v1 worker when page-global state claims v2', async () => {
    (globalThis as Record<string, unknown>)[modeKey] = 'v2';
    vi.stubGlobal('Worker', MockWorker);
    MockWorker.instances = [];
    vi.mocked(runBrowserScanV2).mockResolvedValue({ ok: true, result: {} } as never);
    vi.mocked(toScannerReportModelV2).mockReturnValue({ policyProfile: 'beta-default' } as never);

    const result = await runScan({ json: '{"nodes":[]}', profile: 'beta-default', approvedDomains: [] });

    expect(result).toMatchObject({ policyProfile: 'beta-default' });
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0].lastScanRequest).toMatchObject({ kind: 'scan', profile: 'beta-default' });
    expect(runBrowserScanV2).not.toHaveBeenCalled();
    expect(toScannerReportModelV2).not.toHaveBeenCalled();
  });
});
