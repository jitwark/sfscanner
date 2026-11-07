import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = 'packages/scanner-cli/src/v2/__fixtures__/clean-workflow.json';
export const PUBLIC_ACQUISITION_ENTRIES = '13,221';
export const IGNORED_PROBES = Object.freeze(['.task-demo.json', 'demo.tgz', 'outputs/distribution/demo.tgz']);
// `git check-ignore --no-index` evaluates patterns, so a probe path only has to be
// representable, not present. The second path reserves the scanner fixture location:
// a wildcard `.tgz` rule would ignore it and mask a shipped fixture.
export const NON_IGNORED_PROBES = Object.freeze([FIXTURE, 'packages/scanner-cli/fixtures/sample.tgz']);
const ROW = /^\| \[([^\]]+)\]\(([^)]+)\) \| ([^|]+?) \| ([\d,]+) \|$/u;
const TOTALS = /Active-source canonical entries: ([\d,]+)\. Excluded-source canonical entries with retained credit: ([\d,]+)\. Total canonical entries: ([\d,]+)\./u;
const EXCLUDED_HEADING = '## Excluded sources with retained credit';
const toNumber = (value) => Number(value.replaceAll(',', ''));

export function parseRegister(register) {
  const excludedAt = register.indexOf(EXCLUDED_HEADING);
  if (excludedAt < 0) return { active: [], excluded: [], totals: null };
  const rows = (text) => text.split('\n').flatMap((line) => {
    const match = ROW.exec(line);
    return match ? [{ name: match[1], licence: match[3].trim(), count: toNumber(match[4]) }] : [];
  });
  const totals = TOTALS.exec(register);
  return {
    active: rows(register.slice(0, excludedAt)),
    excluded: rows(register.slice(excludedAt)),
    totals: totals ? { active: toNumber(totals[1]), excluded: toNumber(totals[2]), total: toNumber(totals[3]) } : null,
  };
}

// The register is checked against the source configuration and the corpus total, not against prose:
// a dropped source row or a dropped retained-credit row changes an arithmetic identity that must hold.
export function auditAttributionRegister({ sources, register, analyticsTotal }) {
  const errors = [];
  const { active, excluded, totals } = parseRegister(register);
  const expectedLicence = (source) => source.expectedLicence ?? 'No asserted licence';
  const nameOf = (source) => (source.kind === 'n8n_official' ? 'Official n8n templates' : source.repo);

  for (const source of sources.filter((entry) => entry.status === 'active')) {
    const matches = active.filter((row) => row.name === nameOf(source));
    if (matches.length !== 1) errors.push(`ATTRIBUTIONS.md:1: active source ${nameOf(source)} must appear exactly once`);
    else if (matches[0].licence !== expectedLicence(source)) errors.push(`ATTRIBUTIONS.md:1: ${nameOf(source)} licence does not match pipeline/sources.json`);
  }
  const excludedNames = new Set(sources.filter((entry) => entry.status === 'excluded').map(nameOf));
  for (const row of excluded) {
    if (!excludedNames.has(row.name)) errors.push(`ATTRIBUTIONS.md:1: retained-credit row ${row.name} has no excluded source`);
    const source = sources.find((entry) => nameOf(entry) === row.name);
    if (source && row.licence !== expectedLicence(source)) errors.push(`ATTRIBUTIONS.md:1: ${row.name} retained-credit licence does not match pipeline/sources.json`);
  }

  if (!totals) errors.push('ATTRIBUTIONS.md:1: canonical totals are missing');
  else {
    const sum = (rows) => rows.reduce((total, row) => total + row.count, 0);
    if (sum(active) !== totals.active) errors.push(`ATTRIBUTIONS.md:1: active rows sum to ${sum(active)}, stated ${totals.active}`);
    if (sum(excluded) !== totals.excluded) errors.push(`ATTRIBUTIONS.md:1: retained-credit rows sum to ${sum(excluded)}, stated ${totals.excluded}`);
    if (totals.active + totals.excluded !== totals.total) errors.push('ATTRIBUTIONS.md:1: canonical subtotals do not add up');
    if (totals.total !== analyticsTotal) errors.push(`ATTRIBUTIONS.md:1: canonical total ${totals.total} does not match data/analytics.json total ${analyticsTotal}`);
  }
  if (!register.includes(`Public-tree acquisition entries: ${PUBLIC_ACQUISITION_ENTRIES}.`)) errors.push('ATTRIBUTIONS.md:1: public acquisition basis is missing');
  if (!/not summed with the canonical total/u.test(register)) errors.push('ATTRIBUTIONS.md:1: public acquisition basis is not marked separate');
  return { errors, active, excluded, totals };
}

export function auditLicenceAuthority({ register, licensing }) {
  const errors = [];
  const required = [
    [register, /MIT/u, 'ATTRIBUTIONS.md:1: MIT code authority is not stated'],
    [register, /Personal \/ Non-Commercial/u, 'ATTRIBUTIONS.md:1: dataset authority is not stated'],
    [register, /CC BY-SA 4\.0/u, 'ATTRIBUTIONS.md:1: public metadata defect is not recorded'],
    [register, /unresolved, public-only extraction defect/u, 'ATTRIBUTIONS.md:1: public metadata defect is not marked unresolved'],
    [licensing, /binding terms[^.]*MIT[^.]*Personal\s*\/\s*(?:>\s*)?Non-Commercial/iu, 'docs/LICENSING.md:1: binding licence authority is not stated'],
    [licensing, /REPOSITORY-MODEL\.md[\s\S]{0,120}CC BY-SA 4\.0/iu, 'docs/LICENSING.md:1: public stale-header note is missing'],
  ];
  for (const [text, pattern, message] of required) if (!pattern.test(text)) errors.push(message);
  return errors;
}

function gitIgnored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function auditGitIgnore(root = ROOT) {
  const errors = [];
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
  for (const pattern of ['.task*-*.json', '/*.tgz', '/outputs/distribution/*.tgz']) {
    if (!ignore.split('\n').includes(pattern)) errors.push(`.gitignore:1: missing scoped pattern ${pattern}`);
  }
  if (ignore.split('\n').some((line) => line.trim() === '*.tgz')) errors.push('.gitignore:1: bare *.tgz would mask tracked fixtures');
  for (const path of IGNORED_PROBES) if (!gitIgnored(root, path)) errors.push(`.gitignore:1: ${path} is not ignored`);
  for (const path of NON_IGNORED_PROBES) if (gitIgnored(root, path)) errors.push(`.gitignore:1: ${path} must not be ignored by the scoped rules`);
  return errors;
}

export function auditAttributionBasis(root = ROOT) {
  const resolved = resolve(root);
  const read = (file) => (existsSync(resolve(resolved, file)) ? readFileSync(resolve(resolved, file), 'utf8') : undefined);
  const errors = [];
  try {
    const sources = JSON.parse(readFileSync(resolve(resolved, 'pipeline/sources.json'), 'utf8'));
    const analytics = JSON.parse(readFileSync(resolve(resolved, 'data/analytics.json'), 'utf8'));
    const register = read('ATTRIBUTIONS.md');
    const licensing = read('docs/LICENSING.md');
    if (register === undefined) errors.push('ATTRIBUTIONS.md:1: file is missing');
    if (licensing === undefined) errors.push('docs/LICENSING.md:1: file is missing');
    if (register !== undefined) {
      errors.push(...auditAttributionRegister({ sources, register, analyticsTotal: analytics.total }).errors);
      errors.push(...auditLicenceAuthority({ register, licensing: licensing ?? '' }));
    }
  } catch (error) {
    errors.push(`basis:1: ${error instanceof Error ? error.message : String(error)}`);
  }
  errors.push(...auditGitIgnore(resolved));
  errors.sort();
  return { errors };
}

function main() {
  const result = auditAttributionBasis(ROOT);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log('check-attribution-basis: canonical rows, licence authority, and ignore scopes hold.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
