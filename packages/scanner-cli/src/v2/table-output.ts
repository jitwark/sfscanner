import { coverageOmissionsV2 } from '@hub/scanner-core/report/sarif-v2/output';
import type { BatchResultV2 } from './batch-runner';
import { projectBatchV2, type ProjectedBatchV2, type ProjectionFormatV2, type ProjectionOptionsV2 } from './json-output';
import { PREFLIGHT_DISCLAIMER_V1 } from './preflight-readiness';

type Row = readonly [string, string, string, string, string, string];
type Item = ProjectedBatchV2['items'][number];
const MAX_LISTED_PREREQUISITES = 4;

export function renderTableV2(batch: BatchResultV2, options: ProjectionOptionsV2 | ProjectionFormatV2 = 'json'): string {
  const projected = projectBatchV2(batch, options);
  const headers: Row = ['Input', 'Status', 'Findings', 'Coverage', 'Omitted', 'Error'];
  const rows: Row[] = projected.items.map((item) => {
    if (item.ok) {
      const omissions = coverageOmissionsV2(item.result);
      const coverage = item.result.analysis.capabilities.length ? `${omissions.coverageAnalyzed}/${omissions.coverageSeen}` : '-';
      return [item.input, item.result.analysis.status, String(item.result.findings.length), coverage, String(omissions.omittedTotal), ''];
    }
    const status = item.error.kind === 'CANCELLED' ? 'CANCELLED' : item.error.kind === 'INCOMPLETE' ? 'INCOMPLETE' : item.error.kind === 'INTERNAL' ? 'INTERNAL' : 'ERROR';
    return [item.input, status, '-', '-', '-', item.error.code];
  });
  const escaped = [headers, ...rows].map((row) => row.map(escapeCell));
  const widths = headers.map((_header, column) => Math.max(...escaped.map((row) => row[column]!.length)));
  const line = (row: readonly string[]): string => row.map((value, column) => column === row.length - 1 ? value : value.padEnd(widths[column]!)).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const table = `${line(escaped[0]!)}\n${divider}${rows.length ? `\n${rows.map((_row, index) => line(escaped[index + 1]!)).join('\n')}` : ''}`;
  const readiness = renderReadiness(projected.items);
  return readiness === '' ? `${table}\n` : `${table}\n\n${readiness}\n`;
}

/** Declared offline prerequisites only: nothing here proves a credential works, a package is installed or a workflow runs. */
function renderReadiness(items: readonly Item[]): string {
  const reports = items.flatMap((item) => (item.ok && item.readiness !== undefined ? [{ input: item.input, readiness: item.readiness }] : []));
  if (reports.length === 0) return '';
  const lines: string[] = ['Readiness (declared workflow prerequisites; offline and unverified)'];
  for (const { input, readiness } of reports) {
    const reasons = readiness.completeness.reasons.length === 0 ? '' : ` (${readiness.completeness.reasons.map(({ code }) => code).join(', ')})`;
    lines.push(`  ${escapeCell(input)}`);
    lines.push(`    completeness    ${readiness.completeness.status}${reasons}`);
    lines.push(`    target          ${readiness.target.status}`);
    lines.push(`    credentials     ${listValues(readiness.prerequisites.credentials.map(({ credentialType }) => credentialType))}`);
    lines.push(`    integrations    ${listValues(readiness.prerequisites.integrations.map(({ service }) => service))}`);
    lines.push(`    community nodes ${listValues(readiness.prerequisites.communityNodes.map(({ packageName }) => packageName ?? 'unresolved package'))}`);
    lines.push(`    subworkflows    ${listValues(readiness.prerequisites.subworkflows.map(({ node }) => node))}`);
    lines.push(`    environment     ${listValues(readiness.prerequisites.environment.map(({ name, namespace }) => '$' + namespace.toLowerCase() + '.' + name))}`);
    evidenceRows(lines, 'credential evidence', readiness.prerequisites.credentials.map(({ credentialType, pointer }) => [displayValue(credentialType), pointer] as const));
    evidenceRows(lines, 'integration evidence', readiness.prerequisites.integrations.flatMap(({ service, evidence }) => evidence.map((row) => [evidenceLabel(service, row), row.pointer] as const)));
    evidenceRows(lines, 'community evidence (installation UNKNOWN)', readiness.prerequisites.communityNodes.flatMap(({ packageName, evidence }) => evidence.map((row) => [evidenceLabel(packageName ?? 'unresolved package', row), row.pointer] as const)));
    evidenceRows(lines, 'subworkflow evidence', readiness.prerequisites.subworkflows.map(({ node, pointer }) => [displayValue(node), pointer] as const));
    evidenceRows(lines, 'environment evidence (value UNKNOWN, availability UNKNOWN)', readiness.prerequisites.environment.map(({ name, namespace, evidence }) => [evidenceLabel('$' + namespace.toLowerCase() + '.' + name, evidence), evidence.pointer] as const));
    if (readiness.prerequisites.unknowns.some((unknown) => unknown.startsWith('environment evidence omitted'))) lines.push('    environment evidence omitted: path may contain sensitive dynamic keys');
    if (readiness.prerequisites.unknowns.some((unknown) => unknown.startsWith('computed environment'))) lines.push('    computed environment access UNKNOWN');
    const provenance = readiness.prerequisites.provenance;
    lines.push(`    provenance      ${provenance.source} ${provenance.pointer} (repository, commit, licence, verification ${provenance.repository})`);
  }
  lines.push(`  disclaimer        ${PREFLIGHT_DISCLAIMER_V1.id}: ${PREFLIGHT_DISCLAIMER_V1.text}`);
  return lines.join('\n');
}

function listValues(values: readonly string[]): string {
  if (values.length === 0) return 'none declared';
  const unique = [...new Set(values)].sort().map(displayValue);
  return unique.length <= MAX_LISTED_PREREQUISITES ? unique.join(', ') : `${unique.slice(0, MAX_LISTED_PREREQUISITES).join(', ')} +${unique.length - MAX_LISTED_PREREQUISITES} more`;
}

type EvidenceRow = Readonly<{ node: string; nodeType: string; typeVersion: string | null }>;
function evidenceLabel(name: string, row: EvidenceRow): string {
  return `${displayValue(name)} | ${displayValue(row.node)} | ${displayValue(row.nodeType)} | version ${displayValue(row.typeVersion ?? 'UNKNOWN')}`;
}

function evidenceRows(lines: string[], title: string, rows: readonly (readonly [string, string])[]): void {
  lines.push(`    ${title}`);
  for (const [name, pointer] of rows.slice(0, MAX_LISTED_PREREQUISITES)) {
    lines.push(`      ${name} @ ${safeEvidencePath(pointer)}`);
  }
  if (rows.length > MAX_LISTED_PREREQUISITES) lines.push(`      +${rows.length - MAX_LISTED_PREREQUISITES} more`);
}

function displayValue(value: string): string {
  const escaped = escapeCell(value);
  return escaped.length <= 160 && !/\b(?:sk[-_][\w-]+|AKIA[0-9A-Z]{16})\b/i.test(value) ? escaped : '[omitted]';
}

/** Long or recognizably sensitive paths are withheld, not shortened into misleading pointers. */
function safeEvidencePath(pointer: string): string {
  const escaped = escapeCell(pointer);
  return escaped.length <= 160 && !/\b(?:sk[-_][\w-]+|AKIA[0-9A-Z]{16})\b/i.test(pointer) ? escaped : '[path omitted]';
}

function escapeCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escapes: Readonly<Record<string, string>> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
    return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
