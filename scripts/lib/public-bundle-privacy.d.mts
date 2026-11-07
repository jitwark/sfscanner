export declare const PUBLIC_RELATION_NAMES: readonly string[];
export declare const PUBLIC_RELATION_NAMES_V4: readonly string[];

export type PublicBundlePrivacyResult = {
  totals: Record<string, number>;
  entriesAffected: Record<string, string[]>;
  scanned: number;
};

export function bundleDocuments(bundleDir: string): Generator<{ id: string; text: string }>;
export function sweepBundle(bundleDir: string): PublicBundlePrivacyResult;
export function summaryFieldPaths(result: PublicBundlePrivacyResult): Record<string, [string, number][]>;
export function baselineTotals(baseline: unknown): Record<string, number>;
export function regressions(result: PublicBundlePrivacyResult, totals: Record<string, number>): string[];
