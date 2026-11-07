import { prepareBrowserScanV2 } from './scanner-v2-adapter';
import { preloadReportExportActions } from './report/report-export-actions-loader';

export function prepareScannerRuntime(): void {
  if (typeof Worker === 'undefined') return;
  prepareBrowserScanV2();
  void import('./report/report-result').catch(() => {});
  preloadReportExportActions();
}
