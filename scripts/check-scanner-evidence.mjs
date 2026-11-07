import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBaselineReport } from './measure-scanner-baseline.mjs';

const BACKUP = 'D:/projects/secureflow-scanner-preworktree-backup-20260905';
export const EXPECTED_ARTIFACTS = Object.freeze([
  { id: 'MD-20260905', path: `${BACKUP}/compass_artifact_wf-d73f7e82-3e65-5bfe-8959-82d25cf407fa_text_markdown.md`, sha256: '6A4C333AD93CF715930545720D3ABCFCD46354E28FB23D66D906DA280A1978A7' },
  { id: 'XLSX-20260905', path: `${BACKUP}/N8n Platform Security Vulnerabilities and Mitigation Summary.xlsx`, sha256: '7CF2D409C04E99B1173699106E1528E92A7CB1BFA1FF022A5C8013B2BC118638' },
  { id: 'DOCX-20260905', path: `${BACKUP}/SecureFlow-Deep-Research.docx`, sha256: 'CE2F03690CBBE51E3BFC4E33D6AAA268283D835DBAA8A2800483CBB5929D13F4' },
]);
export const REQUIRED_RESEARCH_IDS = Object.freeze([
  'R-001 omitted-parser-defaults', 'R-002 malformed-params', 'R-003 duplicate-keys',
  'R-004 whole-export-preservation', 'R-005 graph-budgets', 'R-006 analyzer-isolation',
  'R-007 unknown-rule-fail-open', 'R-008 expression-islands', 'R-009 placeholders-providers',
  'R-010 invalid-auth', 'R-011 hardened-wiring', 'R-012 source-sarif-spans',
  'R-013 secret-analyzer-caps', 'R-014 dynamic-destinations', 'R-015 taint-ports-items',
  'R-016 taint-branches-overwrites', 'R-017 taint-subworkflows', 'R-018 independent-sources',
  'R-019 effect-argument-approval', 'R-020 workflow-host-advisories', 'R-021 spreadsheet-quarantine',
  'R-022 structural-redaction', 'R-023 expression-lexical-recovery', 'R-024 code-lexical-recovery',
  'R-025 cli-batching-config', 'R-026 cli-atomic-exits-os', 'R-027 docs-provenance-release',
  'R-028 community-hub-gates',
]);
const HEX = /^[0-9a-f]{64}$/i;
const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());

export function validateEvidenceLedger(markdown, { artifactDigests = {}, fileDigests = {} } = {}) {
  const errors = [];
  if (typeof markdown !== 'string' || markdown.length === 0) return { ok: false, errors: ['evidence ledger is empty'] };
  for (const artifact of EXPECTED_ARTIFACTS) {
    const match = markdown.match(new RegExp(`(?:^|\\n)\\s*-\\s*${artifact.id}\\s*:\\s*([0-9a-f]{64})`, 'i'));
    if (!match || match[1].toUpperCase() !== artifact.sha256) errors.push(`${artifact.id} ledger digest does not match the approved digest`);
    const declared = artifactDigests[artifact.id];
    if (declared !== undefined && String(declared).toUpperCase() !== artifact.sha256) errors.push(`${artifact.id} approved digest input is inconsistent`);
    const actual = fileDigests[artifact.id];
    if (actual !== undefined && String(actual).toUpperCase() !== artifact.sha256) errors.push(`${artifact.id} source file digest does not match the approved digest`);
  }
  const lines = markdown.split(/\r?\n/);
  for (const id of REQUIRED_RESEARCH_IDS) {
    const line = lines.find((candidate) => new RegExp(`^\\s*\\|\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`).test(candidate));
    if (!line) { errors.push(`${id} research disposition is missing`); continue; }
    const row = cells(line);
    if (row.length !== 8) { errors.push(`${id} ledger row must have eight fields`); continue; }
    if (!row[1] || !EXPECTED_ARTIFACTS.some((artifact) => row[1].includes(artifact.id))) errors.push(`${id} has no approved source artifact`);
    if (!row[2]) errors.push(`${id} has an empty finding`);
    if (!row[3]) errors.push(`${id} has no OpenSpec requirement`);
    if (!row[4]) errors.push(`${id} has no task`);
    if (!row[5]) errors.push(`${id} has no focused test or gate`);
    if (!row[6]) errors.push(`${id} has an empty disposition`);
    if (!row[7]) errors.push(`${id} has an empty status`);
  }
  return { ok: errors.length === 0, errors };
}

async function digest(path) { return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase(); }
async function main() {
  const root = resolve(import.meta.dirname, '..');
  const ledger = await readFile(resolve(root, 'docs/audit/2026-09-05-scanner-research-ledger.md'), 'utf8');
  const baselineText = await readFile(resolve(root, 'docs/scanner/baseline-v1.json'), 'utf8');
  const baseline = JSON.parse(baselineText);
  const baselineValidation = validateBaselineReport(baseline);
  if (!baselineValidation.ok || baselineText.includes('sk_live_parity_fixture_secret')
    || baseline.cases?.some((item) => Object.hasOwn(item, 'json'))) {
    throw new Error(`baseline evidence is invalid: ${baselineValidation.errors.join('; ') || 'raw workflow content present'}`);
  }
  const fileDigests = {};
  const verifySources = process.argv.includes('--verify-sources');
  if (verifySources) for (const artifact of EXPECTED_ARTIFACTS) fileDigests[artifact.id] = await digest(artifact.path);
  const result = validateEvidenceLedger(ledger, { fileDigests });
  if (!result.ok) throw new Error(result.errors.join('; '));
  const sourceStatus = verifySources ? 'source files verified' : 'approved identities validated';
  console.log(`Scanner evidence passed: ${REQUIRED_RESEARCH_IDS.length} research dispositions, ${EXPECTED_ARTIFACTS.length} ${sourceStatus}, and ${baseline.cases.length} baseline cases.`);
}
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { await main(); } catch (cause) { console.error(`Scanner evidence failed: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 1; } }
