export function evaluate(input: {
  outDir: string;
  siteUrl: string;
  basePath?: string;
  datasetDir?: string | null;
  sourceDataDir?: string | null;
}): { violations: string[] };
export function resolveDatasetDir(argv?: string[], env?: Record<string, string | undefined>): string | null;
export function resolveSourceDataDir(argv?: string[]): string;
