import { LIMITS, type EntrySecurity, type PublicFinding, type Severity } from '@hub/contracts';
import type { ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { V1_RULE_TEMPLATES } from '@hub/scanner-core/compat/v1-registry';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

/**
 * The canonical `Entry.security` projection of one native v2 result.
 *
 * Two decisions are deliberate:
 *
 * - Findings and severity counts are the engine's actual observed output, whatever the analysis
 *   status is. A DEGRADED or INDETERMINATE run can still have found real issues, and dropping them
 *   because the assessment is null would turn an incomplete scan into an apparent clean one.
 * - A null assessment (the engine withheld a grade) publishes `UNKNOWN`/`0`, the corpus's existing
 *   "no numeric verdict" sentinel. The findings stay; only the aggregate grade/score is absent.
 *
 * Rule prose comes from the registered v1 rule templates, which cover every admitted v2 rule id;
 * no evidence, location, or parameter value crosses this boundary.
 */
const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const PROSE: Record<string, (typeof V1_RULE_TEMPLATES)[number]> = Object.fromEntries(V1_RULE_TEMPLATES.map((template) => [template.ruleId, template]));

export function v2ResultToEntrySecurity(result: ScannerResultV2): EntrySecurity {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of result.findings) counts[finding.severity.toLowerCase() as keyof typeof counts] += 1;

  const findings: PublicFinding[] = result.findings
    .map((finding): PublicFinding => {
      const template = PROSE[finding.ruleId];
      const candidateNode = finding.subject.kind === 'NODE' ? finding.subject.node.name : undefined;
      const node = candidateNode !== undefined && candidateNode.length <= 512 && !/[\u0000-\u001f\u007f]/.test(candidateNode)
        ? candidateNode : undefined;
      return {
        id: finding.ruleId,
        title: template?.title ?? finding.ruleId,
        severity: finding.severity,
        ...(node === undefined || node.trim().length === 0 ? {} : { node }),
        why: template?.whyItMatters ?? template?.explanation ?? '',
        fix: template?.remediation ?? '',
      };
    })
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
      || compareCanonicalStrings(left.id, right.id))
    .slice(0, LIMITS.maxPublicFindings);

  const diagnosticCodes = [...new Set(result.analysis.diagnostics.map((diagnostic) => diagnostic.code))].sort(compareCanonicalStrings);
  const indeterminate = result.analysis.status === 'INDETERMINATE';
  return {
    schemaVersion: 'scanner-result-v2',
    grade: indeterminate ? 'UNKNOWN' : result.assessment?.grade ?? 'UNKNOWN',
    score: indeterminate ? 0 : result.assessment?.score ?? 0,
    counts,
    findings,
    hardenedExtra: 0,
    scannerVersion: result.engine.version,
    profile: 'beta-default',
    analysisStatus: result.analysis.status,
    // The entry contract allows diagnostic codes only on a non-COMPLETE result; a COMPLETE scan
    // can still carry no-effect diagnostics, and those do not become a degraded marker.
    ...(result.analysis.status !== 'COMPLETE' && diagnosticCodes.length > 0 ? { analysisDiagnosticCodes: diagnosticCodes } : {}),
  };
}
