import { readFileSync } from 'node:fs';
import type {
  CliExplainDocumentV2,
  CliMetadataDocumentV2,
  CliProfilesDocumentV2,
  CliRulesDocumentV2,
  CliVersionDocumentV2,
} from './commands.js';
import {
  explainDocumentV2,
  isAdmittedConfigPathV2,
  profilesDocumentV2,
  rulesDocumentV2,
  runCommandV2,
  validateConfigDocumentV2,
  versionDocumentV2,
} from './commands.js';
import type { CliCommandV2 } from './arguments.js';
import { validateDocumentShape } from './metadata-validation.js';

export type MetadataFormatV2 = 'json' | 'table';
export type MetadataOutputOptionsV2 = Readonly<{ color?: boolean; configDirectory?: string }>;

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const formatRow = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const body = rows.map(formatRow).join('\n');
  return `${formatRow(headers)}\n${sep}${body ? `\n${body}` : ''}\n`;
}

function renderExplainTable(doc: CliExplainDocumentV2): string {
  const { rule: r, prose: p } = doc;
  const steps = p.remediationSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
  const ev = doc.evidenceProperties.length ? doc.evidenceProperties.join(', ') : 'none';
  return [`Rule: ${r.ruleId} (${r.severity}, ${r.confidence}, ${r.effect})`, `Title: ${p.title}`, `Message: ${p.message}`, `Explanation: ${p.explanation}`, `Why it matters: ${p.whyItMatters}`, `Possible impact: ${p.possibleImpact}`, `Remediation: ${p.remediation}`, `Remediation steps:\n${steps}`, `Evidence properties: ${ev}`].join('\n\n') + '\n';
}

export function renderMetadataTableV2(document: CliMetadataDocumentV2, _options?: MetadataOutputOptionsV2): string {
  validateDocumentShape(document);
  if (document.schemaVersion === 'n8n-scan-rules-v2') return formatTable(['Rule ID', 'Severity', 'Confidence', 'Effect', 'CWE'], document.rules.map((r) => [r.ruleId, r.severity, r.confidence, r.effect, r.cweIds.join(',') || '-']));
  if (document.schemaVersion === 'n8n-scan-explain-v2') return renderExplainTable(document);
  if (document.schemaVersion === 'n8n-scan-profiles-v2') return formatTable(['Profile', 'Version', 'Admitted', 'Capabilities', 'Digest'], document.profiles.map((p) => [p.id, p.version, p.admitted ? 'yes' : 'no', String(p.capabilities.length), p.digest.slice(0, 16)]));
  if (document.schemaVersion === 'n8n-scan-version-v2') return [`${document.name} v${document.cliVersion} (mode: ${document.mode})`, `Engine: ${document.engine.id} v${document.engine.version} (${document.engine.buildDigest.slice(0, 16)})`, `Config schema: ${document.configSchema}`, `Ruleset digest: ${document.rulesetDigest.slice(0, 16)}`, `Semantics digest: ${document.semanticsDigest.slice(0, 16)}`].join('\n') + '\n';
  return 'Configuration is valid.\n';
}

export function serializeMetadataJsonV2(document: CliMetadataDocumentV2): string {
  validateDocumentShape(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function serializeMetadataV2(document: CliMetadataDocumentV2, format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): string {
  if (format === 'table') return renderMetadataTableV2(document, options);
  if (format === 'json') return serializeMetadataJsonV2(document);
  throw new TypeError('Invalid format');
}

export function emitRulesDocumentV2(format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): string { return serializeMetadataV2(rulesDocumentV2(), format, options); }
export function emitExplainDocumentV2(ruleId: string, format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): Readonly<{ ok: true; output: string } | { ok: false; code: 'USAGE'; message: string }> {
  const res = explainDocumentV2(ruleId); if (!res.ok) return res;
  return Object.freeze({ ok: true as const, output: serializeMetadataV2(res.document, format, options) });
}
export function emitProfilesDocumentV2(format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): string { return serializeMetadataV2(profilesDocumentV2(), format, options); }
export function emitVersionDocumentV2(format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): string { return serializeMetadataV2(versionDocumentV2(), format, options); }
export function emitConfigValidationDocumentV2(input: unknown, format: MetadataFormatV2 = 'json', options?: MetadataOutputOptionsV2): Readonly<{ ok: true; output: string } | { ok: false; code: 'USAGE'; message: string }> {
  const res = validateConfigDocumentV2(input, options?.configDirectory); if (!res.ok) return res;
  return Object.freeze({ ok: true as const, output: serializeMetadataV2(res.document, format, options) });
}

export function emitMetadataCommandResultV2(command: CliCommandV2, configInput?: unknown, options?: MetadataOutputOptionsV2): Readonly<{ ok: true; output: string } | { ok: false; code: 'USAGE'; message: string }> {
  if (command.kind === 'scan') return Object.freeze({ ok: false as const, code: 'USAGE', message: 'Scan command is not a metadata command.' });
  if (command.kind === 'validate-config') {
    if (!isAdmittedConfigPathV2(command.path)) {
      return Object.freeze({ ok: false as const, code: 'USAGE', message: 'Configuration path is not admitted.' });
    }
    let input = configInput;
    if (input === undefined) {
      try { input = readFileSync(command.path, 'utf8'); } catch { return Object.freeze({ ok: false, code: 'USAGE', message: 'Configuration could not be read.' }); }
    }
    const res = validateConfigDocumentV2(input, options?.configDirectory);
    if (!res.ok) return res;
    return Object.freeze({ ok: true as const, output: serializeMetadataV2(res.document, command.format, options) });
  }
  const res = runCommandV2(command, configInput, options?.configDirectory);
  if (!res.ok) return res;
  if ('command' in res) return Object.freeze({ ok: false as const, code: 'USAGE', message: 'Unexpected scan command.' });
  return Object.freeze({ ok: true as const, output: serializeMetadataV2(res.document, command.format, options) });
}
