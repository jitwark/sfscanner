/**
 * The release audit gate, with explicit and auditable waivers.
 *
 * `npm audit --audit-level=moderate` is a core gate, and it exits 1 on the one advisory this release
 * has decided to accept (`scripts/lib/audit-waivers.json`, decided in
 * `docs/decisions/ADR-dependency-advisory-remediation.md`). Disabling the gate would also stop it
 * catching a *new* advisory, so instead this runs the same audit, subtracts only the reviewed
 * advisories by id, and fails on everything else. It prints every waiver it applies, so the release
 * log states what was accepted rather than leaving it implicit.
 *
 * Propagation nodes are handled honestly: an audit entry with no advisory of its own (micromatch,
 * fast-glob, @next/eslint-plugin-next, eslint-config-next all merely carry the braces chain) passes
 * only while every node it descends from is itself waived.
 *
 * Usage: node scripts/audit-with-waivers.mjs [--waivers <path>]
 * Exit 0 only when no un-waived advisory remains; exit 1 on any remaining advisory, on an unreadable
 * or malformed waiver file, and when the audit itself cannot be parsed (fail closed).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const waiversIndex = args.indexOf('--waivers');
const waiversPath = waiversIndex === -1 ? join(root, 'scripts', 'lib', 'audit-waivers.json') : args[waiversIndex + 1];

function loadWaivers() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(waiversPath, 'utf8'));
  } catch (error) {
    console.error(`audit gate: waiver file unreadable (${waiversPath}): ${error.message}`);
    process.exit(1);
  }
  const list = Array.isArray(parsed.advisories) ? parsed.advisories : [];
  const byId = new Map();
  for (const entry of list) {
    if (typeof entry?.id !== 'string' || typeof entry?.package !== 'string') {
      console.error(`audit gate: waiver entry needs an id and a package: ${JSON.stringify(entry)}`);
      process.exit(1);
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

function runAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['audit', '--json', '--audit-level=moderate'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`audit gate: could not run npm audit: ${result.error.message}`);
    process.exit(1);
  }
  if (!result.stdout) {
    console.error('audit gate: npm audit produced no report (fail closed)');
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error('audit gate: npm audit report was not JSON (fail closed)');
    process.exit(1);
  }
}

/** Advisories npm reports directly on a package, as opposed to the names in `via`. */
const advisoryId = (via) => {
  const url = typeof via?.url === 'string' ? via.url : '';
  const ghsa = /GHSA-[0-9A-Za-z-]+/i.exec(url);
  if (ghsa !== null) return ghsa[0];
  // npm's `source` is a numeric advisory id, not a GHSA; keep it addressable rather than dropping it,
  // because dropping it is what once let every entry pass as a parentless propagation node.
  if (typeof via?.source === 'number') return `source:${via.source}`;
  return typeof via?.title === 'string' ? via.title : undefined;
};

const directAdvisories = (entry) =>
  (Array.isArray(entry?.via) ? entry.via : [])
    .filter((via) => via !== null && typeof via === 'object')
    .map(advisoryId)
    .filter((id) => typeof id === 'string');

const propagatedNames = (entry) =>
  (Array.isArray(entry?.via) ? entry.via : []).filter((via) => typeof via === 'string');

const report = runAudit();
const waivers = loadWaivers();
const vulnerabilities = report?.vulnerabilities ?? {};
const entries = Object.entries(vulnerabilities);

if (entries.length === 0) {
  console.log(`audit gate passed: no advisories reported at --audit-level=moderate.`);
  process.exit(0);
}

const settled = new Map();
let changed = true;
while (changed) {
  changed = false;
  for (const [name, entry] of entries) {
    if (settled.has(name)) continue;
    const own = directAdvisories(entry);
    if (own.length > 0) {
      const unwaived = own.filter((id) => !waivers.has(id));
      settled.set(name, { allowed: unwaived.length === 0, own, unwaived });
      changed = true;
      continue;
    }
    const parents = propagatedNames(entry);
    if (parents.length === 0) {
      // No advisory of its own and nothing to descend from: npm gave us something this gate cannot
      // classify, which is a failure, not a pass.
      settled.set(name, { allowed: false, own: [], unwaived: [], from: [] });
      changed = true;
      continue;
    }
    if (parents.every((parent) => settled.get(parent)?.allowed === true)) {
      settled.set(name, { allowed: true, own: [], unwaived: [], from: parents });
      changed = true;
    }
  }
}

const failures = [];
for (const [name, entry] of entries) {
  const decision = settled.get(name);
  const severity = entry.severity ?? 'unknown';
  if (decision?.allowed === true) {
    const detail = decision.own.length > 0
      ? decision.own.map((id) => { const w = waivers.get(id); return `${id} (${w.decision ?? `fix: ${w.fix}`})`; }).join(', ')
      : `carried by ${decision.from.join(', ')}`;
    console.log(`audit gate: waived ${name} [${severity}] - ${detail}`);
    continue;
  }
  const advisory = decision?.own.length ? decision.own.join(', ') : directAdvisories(entry).join(', ') || 'unresolved chain';
  failures.push(`${name} [${severity}] ${advisory}`);
}

if (failures.length > 0) {
  console.error(`audit gate failed: ${failures.length} un-waived advisory entr${failures.length === 1 ? 'y' : 'ies'}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`Waivers are declared in ${waiversPath} and decided in the ADR it names.`);
  process.exit(1);
}

console.log(`audit gate passed with ${entries.length} waived entr${entries.length === 1 ? 'y' : 'ies'}; no un-waived advisories.`);
