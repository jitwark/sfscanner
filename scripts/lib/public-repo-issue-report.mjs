// Turns a manifest's flat issues array (plus required-tree and exemption
// context) into an owner-reviewable, classified report: grouped by class
// and, for unsafe-content, by underlying detector rule, with enough
// per-item context (path, message) for a human to decide. This module never
// decides that an issue is resolved — it only classifies what exists.
export const REPORT_SCHEMA_VERSION = 'public-repo-issue-report-v1';

function unsafeContentRule(message) {
  const separator = message.indexOf(' at ');
  return separator === -1 ? message : message.slice(0, separator);
}

export function buildIssueClassificationReport({ manifest, requiredMissing = [], structuralGaps = [], exemptionSummary = { appliedCount: 0, stale: [] } }) {
  const issues = manifest?.issues ?? [];
  const byCode = {};
  const items = {};
  const unsafeContentByRule = {};
  for (const entry of issues) {
    byCode[entry.code] = (byCode[entry.code] ?? 0) + 1;
    (items[entry.code] ??= []).push({ path: entry.path, message: entry.message });
    if (entry.code === 'unsafe-content') {
      const rule = unsafeContentRule(entry.message);
      unsafeContentByRule[rule] = (unsafeContentByRule[rule] ?? 0) + 1;
    }
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    targetRepository: manifest?.targetRepository ?? null,
    totals: { issueCount: issues.length, byCode, unsafeContentByRule },
    items,
    requiredMissing,
    structuralGaps,
    exemptionSummary,
  };
}

function renderCountLines(counts, indent = '') {
  return Object.keys(counts).sort().map((key) => `${indent}${key}: ${counts[key]}`);
}

export function renderIssueClassificationSummary(report) {
  const lines = ['Issue classification:', ...renderCountLines(report.totals.byCode, '  ')];
  if (Object.keys(report.totals.unsafeContentByRule).length > 0) {
    lines.push('  unsafe-content by rule:', ...renderCountLines(report.totals.unsafeContentByRule, '    '));
  }
  if (report.requiredMissing.length > 0) lines.push(`Phase 7 required paths missing: ${report.requiredMissing.length}`);
  if (report.structuralGaps.length > 0) lines.push(`Structural gaps: ${report.structuralGaps.length}`);
  if (report.exemptionSummary.appliedCount > 0) lines.push(`Content-safety exemptions applied: ${report.exemptionSummary.appliedCount}`);
  if (report.exemptionSummary.stale.length > 0) lines.push(`Stale exemptions (no matching finding): ${report.exemptionSummary.stale.length}`);
  return `${lines.join('\n')}\n`;
}

function renderClassSection(code, entries) {
  const lines = [`## ${code} (${entries.length})`, ''];
  for (const entry of entries) lines.push(`- \`${entry.path}\`: ${entry.message}`);
  return [...lines, ''];
}

export function renderIssueClassificationMarkdown(report) {
  const lines = [
    '# Public repository extraction issue report',
    '',
    `Schema: \`${report.schemaVersion}\`. Target repository: \`${report.targetRepository}\`.`,
    '',
    'This report classifies every issue produced by `node scripts/extract-public-repo.mjs` for owner review. '
      + 'It resolves nothing on its own: an item stays here, blocking extraction, until an owner records a decision '
      + '(create the path, adjust the allowlist, or add a narrowly-scoped exemption to `scripts/lib/public-repo-content-exemptions.json`).',
    '',
    `## Totals: ${report.totals.issueCount} issue(s)`,
    '',
    ...renderCountLines(report.totals.byCode).map((line) => `- ${line}`),
    '',
  ];
  if (Object.keys(report.totals.unsafeContentByRule).length > 0) {
    lines.push('### unsafe-content by detector rule', '', ...renderCountLines(report.totals.unsafeContentByRule).map((line) => `- ${line}`), '');
  }
  if (report.requiredMissing.length > 0) {
    lines.push('## Missing Phase 7 required paths', '');
    for (const entry of report.requiredMissing) lines.push(`- \`${entry.path}\`: ${entry.description}`);
    lines.push('');
  }
  if (report.structuralGaps.length > 0) {
    lines.push('## Structural gaps', '');
    for (const gap of report.structuralGaps) lines.push(`- required \`${gap.requiredPath}\`, existing \`${gap.existingPath}\`: ${gap.description}`);
    lines.push('');
  }
  if (report.exemptionSummary.stale.length > 0) {
    lines.push('## Stale content-safety exemptions', '', 'These entries match nothing in the current scan and should be reviewed for removal.', '');
    for (const entry of report.exemptionSummary.stale) lines.push(`- \`${entry.path}\` / \`${entry.rule}\``);
    lines.push('');
  }
  for (const code of Object.keys(report.items).sort()) lines.push(...renderClassSection(code, report.items[code]));
  return `${lines.join('\n')}\n`;
}
