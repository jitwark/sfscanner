import { buildSarifDocument, type SarifNotification } from '@hub/scanner-core/report/sarif-document';
import type { CliJsonDocument, CliJsonItem } from './cli-runner.js';
import type { ScanFormat } from './cli-contract.js';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

type CliErrorItem = Extract<CliJsonItem, { ok: false }>;
export type CliOutputOptions = { color?: boolean };

export function formatScanOutput(document: CliJsonDocument, format: ScanFormat, options: CliOutputOptions = {}): string {
  if (format === 'json') return `${JSON.stringify(document, null, 2)}\n`;
  if (format === 'table') return formatTable(document, options);
  return `${JSON.stringify(toSarif(document), null, 2)}\n`;
}

function formatTable(document: CliJsonDocument, options: CliOutputOptions): string {
  const rows = document.results.map((item) => {
    if (!item.ok) return [escapeTableCell(item.input), 'ERROR', escapeTableCell(item.error.code)];
    return [escapeTableCell(item.input), item.result.analysisStatus, String(item.result.findings.length)];
  });
  const headers = ['Input', 'Status', 'Findings'];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  const line = (row: string[]) => row.map((value, index) => {
    const padded = value.padEnd(widths[index]!);
    return index === 1 ? colorStatus(padded, value, options.color === true) : padded;
  }).join('  ');
  return `${line(headers)}\n${widths.map((width) => '-'.repeat(width)).join('  ')}\n${rows.map(line).join('\n')}${rows.length ? '\n' : ''}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escapes: Record<string, string> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
    return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function colorStatus(value: string, status: string, enabled: boolean): string {
  if (!enabled) return value;
  const color = status === 'COMPLETE' ? '\u001b[32m' : status === 'DEGRADED' ? '\u001b[33m' : '\u001b[31m';
  return `${color}${value}\u001b[39m`;
}

// Document assembly (rules, sorted results, CWE tags via sarif-tags.ts) lives in
// @hub/scanner-core/report/sarif-document, shared with packages/scanner-cli — the
// standalone npm package emits the same SARIF shape for a single input. Only the
// notification list stays here: pipeline's CliErrorItem (kind/code/input/message
// across a batch) has no equivalent in the single-input package.
function toSarif(document: CliJsonDocument): Record<string, unknown> {
  const findings = document.results.flatMap((item) => item.ok
    ? item.result.findings.map((finding) => ({ input: item.input, finding }))
    : []);
  const notifications = document.results.filter((item): item is CliErrorItem => !item.ok)
    .sort(compareCliErrors)
    .map(toNotification);
  return buildSarifDocument({
    toolName: 'n8n-scan',
    toolVersion: '0.1.0',
    informationUri: 'https://github.com/jitwark/n8n-Secureflow',
    findings,
    notifications,
    executionSuccessful: document.summary.inputErrors === 0 && document.summary.internalErrors === 0 && document.summary.cancelled === 0 && !document.results.some((item) => item.ok && item.result.analysisStatus === 'INDETERMINATE'),
  });
}

function toNotification(item: CliErrorItem): SarifNotification {
  return {
    descriptor: { id: item.error.code },
    message: { text: `${item.input}: ${item.error.message}` },
    properties: { input: item.input, kind: item.error.kind, code: item.error.code },
  };
}

function compareCliErrors(left: CliErrorItem, right: CliErrorItem): number {
  return compareCanonicalStrings(left.input, right.input) ||
    compareCanonicalStrings(left.error.kind, right.error.kind) ||
    compareCanonicalStrings(left.error.code, right.error.code) ||
    compareCanonicalStrings(left.error.message, right.error.message);
}
