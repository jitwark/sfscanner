import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditScannerV2Docs } from './check-scanner-v2-docs.mjs';
import { auditScannerSourceClaims, AUTHORITATIVE_DOCS } from './check-scanner-source-claims.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GENERATED = ['rules.md', 'diagnostics.md', 'limits.md', 'schemas.md', 'cli.md', 'examples.md'];
// Documents whose `Recorded` date is itself the evidence and must therefore be recent.
//
// `docs/scanner/release-v2-readiness-report.md` used to be listed here. It is the
// 2026-09-09 readiness record for the superseded `codex/release-v2` candidate, and
// it now carries a dated correction banner saying so. Requiring a superseded
// candidate's report to be re-recorded within the freshness window meant the gate
// could only pass by re-stamping measurements that belong to a different candidate;
// the current candidate's equivalent evidence is the F1 gate run and its retained
// log. The report stays in the repository as dated history, and the two calibration
// documents — which are live evidence — stay in this list.
const EVIDENCE_DOCS = ['docs/scanner/calibration-v2.md', 'docs/scanner/calibration-v2-results.md'];
const DAY = 86_400_000;
function add(errors, file, line, message) { errors.push(`${file}:${line}: ${message}`); }
function lineAt(text, index) { return text.slice(0, index).split('\n').length; }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time)) return undefined;
  const date = new Date(time); return date.toISOString().slice(0, 10) === value ? time : undefined;
}
function referenceDate(options, errors) {
  const env = options.env ?? process.env;
  const raw = options.asOf ?? env.REFERENCE_DATE ?? (env.SOURCE_DATE_EPOCH === undefined ? undefined : (() => {
    const epoch = Number(env.SOURCE_DATE_EPOCH); return Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString().slice(0, 10) : undefined;
  })());
  if (!raw) { add(errors, '<reference-date>', 1, 'as-of date is required; pass --as-of or set REFERENCE_DATE/SOURCE_DATE_EPOCH'); return undefined; }
  const time = validDate(String(raw)); if (time === undefined) { add(errors, '<reference-date>', 1, `invalid reference date: ${raw}`); return undefined; }
  return time;
}
function maxAge(options, errors) {
  const value = options.maxAgeDays ?? 30;
  if (!/^\d+$/.test(String(value))) { add(errors, '<max-age-days>', 1, `invalid max-age-days: ${value}`); return undefined; }
  return Number(value);
}
function dateFields(text, labels) {
  const pattern = new RegExp(`\\b(${labels.join('|')}):\\s*([^\\s|,;]+)`, 'gi');
  return [...text.matchAll(pattern)].map((match) => ({ label: match[1], value: match[2].replace(/[.)]+$/, ''), line: lineAt(text, match.index ?? 0) }));
}
function checkDate(errors, file, field, asOf, days) {
  const time = validDate(field.value);
  if (time === undefined) { add(errors, file, field.line, `invalid ${field.label} date: ${field.value}`); return; }
  if (time > asOf) { add(errors, file, field.line, `${field.label} date is in the future: ${field.value}`); return; }
  if (Math.floor((asOf - time) / DAY) > days) add(errors, file, field.line, `${field.label} evidence is stale: ${field.value}`);
}
function read(root, file, errors) {
  try { return readFileSync(resolve(root, file), 'utf8'); } catch { add(errors, file, 1, 'evidence file is missing'); return undefined; }
}

export function auditScannerEvidenceFreshness(root = ROOT, options = {}) {
  const resolved = resolve(root); const errors = []; const asOf = referenceDate(options, errors); const days = maxAge(options, errors);
  const documents = options.documents ?? AUTHORITATIVE_DOCS;
  const source = auditScannerSourceClaims(resolved, { documents, checkGenerated: false });
  errors.push(...source.errors);
  if (asOf !== undefined && days !== undefined) {
    for (const file of documents) {
      const text = read(resolved, file, errors); if (!text) continue;
      const dates = dateFields(text, ['Last verified']);
      if (dates.length !== 1) add(errors, file, dates[0]?.line ?? 1, 'Last verified metadata is missing or malformed');
      dates.forEach((field) => checkDate(errors, file, field, asOf, days));
      dateFields(text, ['Recorded']).forEach((field) => checkDate(errors, file, field, asOf, days));
    }
    for (const file of options.evidenceDocuments ?? EVIDENCE_DOCS) {
      const text = read(resolved, file, []); if (!text) continue;
      dateFields(text, ['Last verified', 'Recorded']).forEach((field) => checkDate(errors, file, field, asOf, days));
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) if (/(?:^|\/)archives?\//i.test(match[1])) add(errors, file, lineAt(text, match.index ?? 0), `archive supersession gap: ${match[1]}`);
    }
  }
  if (options.checkGenerated !== false) {
    const generated = auditScannerV2Docs(resolved, options.generatedDocs ? { docs: options.generatedDocs } : {});
    for (const message of generated.errors) {
      const name = message.match(/^([^:]+\.md):/)?.[1] ?? 'generated';
      add(errors, `docs/scanner/generated/${name}`, 1, message.replace(`${name}: `, ''));
    }
    if (options.generatedDocs && Object.keys(options.generatedDocs).some((name) => !GENERATED.includes(name))) add(errors, 'docs/scanner/generated', 1, 'unsupported generated file');
  }
  errors.sort(); return { errors, asOf: asOf === undefined ? undefined : new Date(asOf).toISOString().slice(0, 10), maxAgeDays: days, documents };
}
function args(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) { if (argv[i] === '--as-of') result.asOf = argv[++i]; else if (argv[i] === '--max-age-days') result.maxAgeDays = argv[++i]; } return result; }
function main() { const result = auditScannerEvidenceFreshness(ROOT, args(process.argv.slice(2))); if (result.errors.length) { console.error(`Scanner evidence freshness failed (${result.errors.length} error(s))`); result.errors.forEach((error) => console.error(`- ${error}`)); process.exitCode = 1; } else console.log(`Scanner evidence freshness passed: ${result.documents.length} documents as of ${result.asOf}.`); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
