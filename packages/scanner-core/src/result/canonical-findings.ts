import type { CanonicalScanFinding, ScanFinding } from '../policy/policy';
import type { RuleCatalogEntry } from '../policy/rule-catalog';
import { redactFinding } from '../redaction/redaction';

export type CanonicalizeFindingsOptions = {
  /** The first `legacyFindingCount` entries are not subject to the analyzer cap. */
  legacyFindingCount?: number;
  maxAnalyzerFindings?: number;
  ambiguousNodeIds?: ReadonlySet<string>;
};

export type CanonicalFindingsResult = {
  findings: CanonicalScanFinding[];
  rejectedCount: number;
  collapsedCount: number;
};

/** Validates, deduplicates, redacts, and stamps the effect of each finding. */
export function canonicalizeFindings(
  findings: unknown[],
  ruleCatalog: readonly RuleCatalogEntry[],
  options: CanonicalizeFindingsOptions = {},
): CanonicalFindingsResult {
  const effectsByPolicyId = new Map(ruleCatalog.map((rule) => [rule.policyId, rule.policyEffect]));
  const canonicalFindings: CanonicalScanFinding[] = [];
  const seen = new Set<string>();
  const legacyFindingCount = Math.max(0, Math.min(options.legacyFindingCount ?? findings.length, findings.length));
  const maxAnalyzerFindings = options.maxAnalyzerFindings ?? Number.POSITIVE_INFINITY;
  let analyzerFindingCount = 0;
  let rejectedCount = 0;
  let collapsedCount = 0;

  for (const [index, value] of findings.entries()) {
    try {
      if (!isScanFinding(value) || hasCycle(value)) {
        rejectedCount += 1;
        continue;
      }

      const finding = value;
      const ambiguous = finding.location.nodeId !== undefined &&
        options.ambiguousNodeIds?.has(finding.location.nodeId);
      const key = ambiguous ? undefined : createMergeKey(finding);
      if (key !== undefined && seen.has(key)) {
        collapsedCount += 1;
        continue;
      }

      const isAnalyzerFinding = index >= legacyFindingCount;
      if (isAnalyzerFinding && analyzerFindingCount >= maxAnalyzerFindings) continue;

      const redacted = redactFinding(finding);
      canonicalFindings.push({
        ...redacted,
        severity: finding.severity,
        confidence: finding.confidence,
        location: {
          nodeId: redacted.location.nodeId,
          nodeName: redacted.location.nodeName,
          path: redacted.location.path,
        },
        policyEffect: effectsByPolicyId.get(finding.policyId) ?? 'LEGACY_SCORE',
      });
      if (key !== undefined) seen.add(key);
      if (isAnalyzerFinding) analyzerFindingCount += 1;
    } catch {
      rejectedCount += 1;
    }
  }

  return { findings: canonicalFindings, rejectedCount, collapsedCount };
}

function createMergeKey(finding: ScanFinding): string | undefined {
  try {
    return stableSerialize({
      policyId: finding.policyId,
      title: finding.title,
      severity: finding.severity,
      location: finding.location,
      evidence: finding.evidence,
      message: finding.message,
      explanation: finding.explanation,
      whyItMatters: finding.whyItMatters,
      possibleImpact: finding.possibleImpact,
      remediation: finding.remediation,
      remediationSteps: finding.remediationSteps,
      confidence: finding.confidence,
    });
  } catch {
    return undefined;
  }
}

function stableSerialize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
  }
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (typeof value !== 'object') throw new Error('Unsupported merge-key value');
  if (seen.has(value)) throw new Error('Cyclic merge-key value');
  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return serialized;
}

function isScanFinding(value: unknown): value is ScanFinding {
  return isRecord(value) && isString(value.policyId) && isString(value.title) &&
    isSeverity(value.severity) && isLocation(value.location) && isRecord(value.evidence) &&
    ['message', 'explanation', 'whyItMatters', 'possibleImpact', 'remediation'].every(
      (key) => isString(value[key]),
    ) && isStringArray(value.remediationSteps) && isConfidence(value.confidence);
}

function hasCycle(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  const cyclic = Array.isArray(value)
    ? value.some((entry) => hasCycle(entry, ancestors))
    : Object.keys(value).some((key) => hasCycle((value as Record<string, unknown>)[key], ancestors));
  ancestors.delete(value);
  return cyclic;
}

function isLocation(value: unknown): boolean {
  return isRecord(value) && ['nodeId', 'nodeName', 'path'].every(
    (key) => value[key] === undefined || isString(value[key]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSeverity(value: unknown): boolean {
  return value === 'CRITICAL' || value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' || value === 'INFO';
}

function isConfidence(value: unknown): boolean {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH';
}
