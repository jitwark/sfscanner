import { compareCanonicalStrings } from '../stable-order.js';
import { sarifHelpUriFor, sarifTagsFor } from './sarif-tags.js';
import type { CanonicalScanFinding, ScanSeverity } from '../policy/policy.js';

/**
 * Shared SARIF 2.1.0 document assembly for the two CLIs that scan a batch of
 * `CanonicalScanFinding`s located by source span: the pipeline-workspace
 * `pipeline/cli/` adapter and the standalone `packages/scanner-cli` package.
 * Before this module existed, both had their own copy of the same
 * rules/results/notifications assembly, and only one of the two ever grew a
 * `--format sarif` flag — the exact way `sarif-tags.ts` describes the CWE tag
 * logic itself drifting between emitters. Only the tag lookup is delegated
 * here rather than rewritten.
 *
 * The browser report (`app/src/scanner/report/report-sarif.ts`) is
 * deliberately not built on this: it redacts text, reports logical locations
 * instead of physical source spans, and adds finding fingerprints and a risk
 * grade for a single workflow. Those needs are particular to one caller, so
 * folding them into a "generic" builder would inflate this shared shape to
 * serve a consumer that does not share it — it already reuses `sarifTagsFor`,
 * which was the actual duplication risk.
 */

const SEVERITY_ORDER: Record<ScanSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

export type SarifFindingEntry = { input: string; finding: CanonicalScanFinding };

export type SarifNotification = {
  descriptor: { id: string };
  message: { text: string };
  properties?: Record<string, unknown>;
};

export type SarifDocumentInput = {
  toolName: string;
  toolVersion: string;
  informationUri: string;
  findings: readonly SarifFindingEntry[];
  /** Pre-sorted by the caller: each caller's notification shape carries different fields to order by. */
  notifications?: readonly SarifNotification[];
  executionSuccessful: boolean;
};

export function buildSarifDocument(input: SarifDocumentInput): Record<string, unknown> {
  const findings = [...input.findings].sort(compareSarifFindings);
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: {
        name: input.toolName, version: input.toolVersion, informationUri: input.informationUri,
        rules: sarifRules(findings),
      } },
      results: findings.map(({ input: source, finding }) => sarifFinding(source, finding)),
      invocations: [{
        executionSuccessful: input.executionSuccessful,
        toolExecutionNotifications: [...(input.notifications ?? [])],
      }],
    }],
  };
}

function sarifRules(findings: readonly SarifFindingEntry[]): Record<string, unknown>[] {
  const rules = new Map<string, CanonicalScanFinding>();
  for (const { finding } of findings) if (!rules.has(finding.policyId)) rules.set(finding.policyId, finding);
  return [...rules.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right)).map(([id, finding]) => {
    const tags = sarifTagsFor(id);
    return {
      id,
      shortDescription: { text: finding.title },
      helpUri: sarifHelpUriFor(id),
      ...(tags ? { properties: { tags } } : {}),
    };
  });
}

function sarifFinding(input: string, finding: CanonicalScanFinding): Record<string, unknown> {
  const sourceSpan = finding.location.sourceSpan;
  const locations = sourceSpan ? [{
    physicalLocation: {
      artifactLocation: { uri: input },
      region: {
        startLine: sourceSpan.start.line,
        startColumn: sourceSpan.start.column,
        endLine: sourceSpan.end.line,
        endColumn: sourceSpan.end.column,
        charOffset: sourceSpan.start.offset,
        charLength: Math.max(0, sourceSpan.end.offset - sourceSpan.start.offset),
      },
    },
  }] : undefined;
  return {
    ruleId: finding.policyId,
    level: sarifLevel(finding.severity),
    message: { text: finding.title },
    ...(locations ? { locations } : {}),
  };
}

function compareSarifFindings(left: SarifFindingEntry, right: SarifFindingEntry): number {
  return compareCanonicalStrings(left.input, right.input) ||
    SEVERITY_ORDER[left.finding.severity] - SEVERITY_ORDER[right.finding.severity] ||
    compareCanonicalStrings(left.finding.policyId, right.finding.policyId) ||
    compareCanonicalStrings(locationKey(left.finding), locationKey(right.finding)) ||
    compareCanonicalStrings(left.finding.title, right.finding.title) ||
    compareCanonicalStrings(left.finding.message, right.finding.message);
}

function locationKey(finding: CanonicalScanFinding): string {
  const location = finding.location;
  const span = location.sourceSpan;
  return [
    location.nodeId ?? '', location.nodeName ?? '', location.path ?? '',
    span ? `${span.start.line}:${span.start.column}:${span.start.offset}:${span.end.line}:${span.end.column}:${span.end.offset}` : '',
  ].join('|');
}

function sarifLevel(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'error';
  if (severity === 'MEDIUM') return 'warning';
  return 'note';
}
