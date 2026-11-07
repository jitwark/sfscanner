import type { ScanFinding, ScanSummary } from '../policy/policy';

export function summarizeFindings(findings: readonly ScanFinding[]): ScanSummary {
  const summary: ScanSummary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  for (const finding of findings) {
    const key = finding.severity.toLowerCase() as keyof ScanSummary;
    summary[key] += 1;
  }

  return summary;
}
