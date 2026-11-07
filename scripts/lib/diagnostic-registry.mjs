import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The diagnostic vocabulary has exactly one author: the normative registry table in
 * `diagnostic-and-exit-registry.md`. The per-code type union, the aggregate-effect column
 * (status) and the assessment column are projected out of that table by
 * `diagnostic-registry-generators.mjs`, so a table row that is added, changed, or removed
 * cannot survive without regenerating the artifacts.
 *
 * The closed *domains* of the table (categories, effect modes, projections) are declared here
 * rather than read out of the table: they are the vocabulary the table is allowed to use, so
 * every cell is validated against them and an out-of-domain cell fails generation instead of
 * silently extending a type.
 */
export const DIAGNOSTIC_REGISTRY_SOURCE = 'openspec/changes/world-class-scanner-cli/diagnostic-and-exit-registry.md';
export const DIAGNOSTIC_REGISTRY_VERSION = 'diagnostic-registry-v1';
export const CATEGORIES = Object.freeze(['LIMIT', 'SOURCE', 'PARSER', 'POLICY', 'GRAPH', 'CATALOGUE', 'COMPATIBILITY']);
export const EFFECT_MODES = Object.freeze(['DEGRADED', 'INDETERMINATE', 'BY_CAPABILITY']);
export const PROJECTIONS = Object.freeze(['SAME', 'MIGRATED', 'PROJECTION_LOSS', 'SENTINEL']);

const ANALYSIS_HEADING = '## Analysis diagnostics';
const CLI_HEADING = '## CLI/tool errors';
const ASSESSMENT_CELLS = Object.freeze({ eligible: true, no: false, 'by effect': 'BY_CAPABILITY' });
const V1_SAME = 'same';
const V1_PROJECTION_LOSS = 'no v1 code; projection loss';
const CODE_CELL = /^`([A-Z][A-Z0-9_]*)`$/;
const SENTINEL_CELL = /^`([A-Z][A-Z0-9_]*)` sentinel$/;

export const fail = (message) => {
  throw new Error(`Invalid diagnostic registry: ${message}`);
};
export const literal = (value) => (typeof value === 'string' ? `'${value}'` : String(value));
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function readDiagnosticRegistrySource(root) {
  try {
    return readFileSync(resolve(root, DIAGNOSTIC_REGISTRY_SOURCE), 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  } catch {
    return fail(`the registry source ${DIAGNOSTIC_REGISTRY_SOURCE} is missing`);
  }
}

/** Lines of the named section, stopping at the next top-level heading. */
function section(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) fail(`the registry source has no ${heading} section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end < 0 ? rest : rest.slice(0, end);
}

function v1ProjectionFor(code, cell) {
  if (cell === V1_SAME) return { v1Code: code, v1Projection: 'SAME' };
  if (cell === V1_PROJECTION_LOSS) return { v1Code: null, v1Projection: 'PROJECTION_LOSS' };
  const sentinel = SENTINEL_CELL.exec(cell);
  if (sentinel) return { v1Code: sentinel[1], v1Projection: 'SENTINEL' };
  const migrated = CODE_CELL.exec(cell);
  if (migrated) return { v1Code: migrated[1], v1Projection: 'MIGRATED' };
  return fail(`unknown v1 code cell ${cell} for ${code}`);
}

function rowFromCells(cells) {
  if (cells.length !== 5) fail(`expected 5 columns, found ${cells.length}: ${cells.join(' | ')}`);
  const [codeCell, category, effectMode, assessmentCell, v1Cell] = cells;
  const code = CODE_CELL.exec(codeCell)?.[1];
  if (!code) fail(`malformed code cell ${codeCell}`);
  if (!CATEGORIES.includes(category)) fail(`unknown category ${category} for ${code}`);
  if (!EFFECT_MODES.includes(effectMode)) fail(`unknown aggregate effect ${effectMode} for ${code}`);
  if (!Object.prototype.hasOwnProperty.call(ASSESSMENT_CELLS, assessmentCell)) fail(`unknown assessment cell ${assessmentCell} for ${code}`);
  const assessmentEligible = ASSESSMENT_CELLS[assessmentCell];
  if ((effectMode === 'BY_CAPABILITY') !== (assessmentEligible === 'BY_CAPABILITY')) {
    fail(`${code} must use \`by effect\` assessment exactly when its effect is BY_CAPABILITY`);
  }
  return { code, category, aggregateEffect: effectMode, assessmentEligible, ...v1ProjectionFor(code, v1Cell) };
}

/**
 * Every analysis-diagnostics table row, in table order, exactly once.
 *
 * Table order is the registry order the runtime relies on (diagnostic ordering and
 * `DIAGNOSTIC_CODES_V2` ranking), so the parser never sorts.
 */
export function parseDiagnosticRegistry(markdown) {
  if (!markdown.includes(ANALYSIS_HEADING) || !markdown.includes(CLI_HEADING)) {
    fail('the registry source no longer has both the analysis diagnostics and CLI/tool error tables');
  }
  const rows = [];
  for (const line of section(markdown, ANALYSIS_HEADING)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells[0] === 'Code' || cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(rowFromCells(cells));
  }
  if (rows.length === 0) fail('the analysis diagnostics table is empty');
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.code)) fail(`duplicate registry entry ${row.code}`);
    seen.add(row.code);
  }
  return rows;
}

export function loadDiagnosticRegistry(root) {
  const source = readDiagnosticRegistrySource(root);
  return { source: DIAGNOSTIC_REGISTRY_SOURCE, digest: digest(source), rows: parseDiagnosticRegistry(source) };
}
