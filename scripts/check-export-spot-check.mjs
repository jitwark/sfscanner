/**
 * AR-6d export spot-check (F-006): compare one sampled export page back to the
 * source that claims to have produced it.
 *
 * Every other export-reading gate holds the export to itself or to a rule of
 * its own making. `check:parity` compares the two page *tiers* to each other;
 * `check:seo` and `check:links` assert per-page shape and resolvable targets;
 * `check:browser-safe:emitted` reads JS; `check:export` counts bytes; and the
 * `release` sequence (`check:corpus`, `check:release`, `check:data-sync`,
 * `check:graph`, `check:catalogue-claim-freshness`) reads `data/` and never
 * opens an emitted HTML file. A site-identity change that is never rebuilt into
 * `app/out` therefore passes all of them — the F-006 class, learned from
 * `b0583f6` (a GitHub-owner rename that invalidated export evidence).
 *
 * This is deliberately narrow: three named pages, three facts each, a digest
 * over the projection, compared against source text read at check time. It is
 * not a byte-compare of the 870 MB export. Design and non-coverage:
 * `docs/audit/2026-09-26-audit-remediation/AR-6D-EXPORT-SPOT-CHECK.md`.
 *
 * Usage: node scripts/check-export-spot-check.mjs [outDir]
 *   SOURCE_ROOT          overrides the root the source literals are read from
 *   NEXT_PUBLIC_BUILD_MODE=preview  drops the canonical fact (preview output
 *                        carries no canonical by design)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const MISSING = '<missing>';
/** Sampled pages named in the design; the third is resolved from the export. */
const FIXED_SAMPLES = Object.freeze([
  { route: '/', relative: 'index.html' },
  { route: '/about/', relative: 'about/index.html' },
]);

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/**
 * The source-of-truth facts, read as text because `check:*` scripts are plain
 * node with no transpile step (mirrors `scripts/lib/legal-identity.mjs`).
 *
 * The site name is a literal in the source. The origin is not: the app reads
 * `NEXT_PUBLIC_SITE_URL` at call time and has no default, so this gate reads
 * the same variable and fails closed rather than comparing against an origin
 * nobody configured. The old repository-literal check moved to the release
 * parity gate, which scans every emitted document instead of one source file.
 * Every failure here is fail-closed: a fact that cannot be read is a finding,
 * not a skip.
 */
export function readSourceFacts(sourceRoot = root, env = process.env) {
  const meta = readText(path.join(sourceRoot, 'app/src/seo/page-meta.ts'));
  if (!meta) throw new Error('source of truth missing: app/src/seo/page-meta.ts');
  const siteName = /export const SITE_NAME = '([^']+)'/.exec(meta)?.[1];
  if (!siteName) throw new Error('source of truth missing: SITE_NAME in app/src/seo/page-meta.ts');
  const raw = (env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (!raw) throw new Error('NEXT_PUBLIC_SITE_URL is required: the export spot-check compares canonicals against the configured release origin');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an absolute https URL without credentials, query, or fragment');
  }
  return { siteName, siteUrl: url.href.replace(/\/$/, '') };
}

/** The three sampled routes: two fixed plus the first workflow entry page. */
export function sampleSpecs(outDir) {
  const specs = FIXED_SAMPLES.map((sample) => ({ ...sample }));
  const entryDir = path.join(outDir, 'w');
  const firstEntry = fs.existsSync(entryDir)
    ? fs.readdirSync(entryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.statSync(path.join(entryDir, entry.name, 'index.html'), { throwIfNoEntry: false })?.isFile())
      .map((entry) => entry.name)
      .sort()[0]
    : undefined;
  if (firstEntry) specs.push({ route: `/w/${firstEntry}/`, relative: `w/${firstEntry}/index.html` });
  return specs;
}

export function projectionDigest(projection) {
  return createHash('sha256').update(projection.map(({ key, value }) => `${key}\t${value}`).join('\n')).digest('hex').slice(0, 16);
}

const canonicalOf = (html) => html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i)?.[1] ?? MISSING;

/**
 * Evaluate one export against the source literals. Returns `{ violations, samples }`;
 * `samples[i]` carries the two projection digests, which the caller prints.
 */
export function evaluate({ outDir = path.join(root, 'app/out'), sourceRoot = root, preview = process.env.NEXT_PUBLIC_BUILD_MODE === 'preview' } = {}) {
  const violations = [];
  const facts = readSourceFacts(sourceRoot);
  const specs = sampleSpecs(outDir);
  if (specs.length < 3) violations.push(`${path.join(outDir, 'w')}: no workflow entry page with an index.html to sample`);
  const samples = [];

  for (const spec of specs) {
    const file = path.join(outDir, spec.relative);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) { violations.push(`${spec.relative}: sampled page is missing`); continue; }
    const html = fs.readFileSync(file, 'utf8');
    if (html.length < 500 || !html.includes('</head>')) {
      violations.push(`${spec.relative}: sampled page is not a complete HTML document (${html.length} bytes)`);
      continue;
    }
    const expectedCanonical = preview ? null : `${facts.siteUrl}${spec.route}`;
    const projection = [
      { key: 'canonical', source: expectedCanonical, export: expectedCanonical === null ? null : canonicalOf(html) },
      { key: 'siteName', source: facts.siteName, export: html.includes(facts.siteName) ? facts.siteName : MISSING },
    ].filter((fact) => fact.source !== null);

    const exportDigest = projectionDigest(projection.map((fact) => ({ key: fact.key, value: fact.export })));
    const sourceDigest = projectionDigest(projection.map((fact) => ({ key: fact.key, value: fact.source })));
    const disagreeing = projection.filter((fact) => fact.export !== fact.source);
    for (const fact of disagreeing) {
      violations.push(`${spec.relative}: ${fact.key} — export ${JSON.stringify(fact.export)} does not match source ${JSON.stringify(fact.source)}`);
    }
    if (disagreeing.length === 0 && exportDigest !== sourceDigest) {
      violations.push(`${spec.relative}: projection digests differ with no named fact (internal inconsistency)`);
    }
    samples.push({ route: spec.route, relative: spec.relative, facts: projection.length, exportDigest, sourceDigest });
  }
  return { violations, samples };
}

export function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(argv[0] ?? path.join(root, 'app/out'));
  const sourceRoot = path.resolve(process.env.SOURCE_ROOT ?? root);
  let result;
  try {
    result = evaluate({ outDir, sourceRoot });
  } catch (error) {
    console.error(`Export spot-check could not run: ${error.message}`);
    return 1;
  }
  for (const sample of result.samples) {
    console.log(`  ${sample.route.padEnd(30)} facts=${sample.facts} export=${sample.exportDigest} source=${sample.sourceDigest}`);
  }
  if (result.violations.length > 0) {
    console.error(`Export spot-check FAILED (${result.violations.length} finding(s)):`);
    for (const violation of result.violations) console.error(`  ${violation}`);
    return 1;
  }
  console.log(`Export spot-check passed: ${result.samples.length} sampled pages compared against ${path.relative(root, sourceRoot) || '.'}.`);
  return 0;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) process.exit(main());
