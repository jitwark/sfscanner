let modulePromise: Promise<typeof import('./report-export-actions')> | undefined;

function loadModule(): Promise<typeof import('./report-export-actions')> {
  modulePromise ??= import('./report-export-actions').catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

export function loadReportExportActions() {
  return loadModule().then((module) => module.ReportExportActions);
}

export function preloadReportExportActions(): void {
  void loadModule().catch(() => {});
}
