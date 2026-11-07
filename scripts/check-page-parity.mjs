/**
 * Hold the two detail-page generators to the same contract.
 *
 * `/w/<slug>/` is written by Next for the pre-rendered tier and by
 * `scripts/generate-lean-pages.tsx` for the other 12,971. They share the React
 * components, so what they *say* cannot drift — but the document around the
 * body is assembled twice, and that is where a canonical, a robots meta or a
 * JSON-LD block can go missing on one side and nobody notice for 12,971 pages.
 *
 * Checked on every page, not a sample: reading them is cheap next to writing
 * them, and a sample cannot tell you which tier a defect belongs to.
 *
 * Usage: node scripts/check-page-parity.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'app', 'out'));
const detailDir = path.join(outDir, 'w');
const previewBuild = process.env.NEXT_PUBLIC_BUILD_MODE === 'preview';
/**
 * The origin decides one rule only: whether a canonical is required or
 * forbidden. A local build without one is supported, and a canonical there
 * would point at an origin the build never had.
 */
const releaseConfigured = Boolean((process.env.NEXT_PUBLIC_SITE_URL ?? '').trim());

/** A page written by Next carries its RSC sidecar; a lean page never does. */
const tierOf = (dir) => (fs.existsSync(path.join(dir, 'index.txt')) ? 'next' : 'lean');

/**
 * Head and body are checked separately, and `<title>` is why.
 *
 * An inline chart SVG carries its own `<title>` as its accessible name, so a
 * whole-document count reports two on every page with a diagram — 231 of the
 * 250 Next pages, all of them correct. Scoping the head rules to the head keeps
 * the gate about the document's metadata.
 */
const headOf = (html) => html.slice(0, html.indexOf('</head>') + 1);

const COMMON_RULES = [
  ['title', (html) => (headOf(html).match(/<title>/g) ?? []).length === 1],
  ['one h1', (html) => (html.match(/<h1[\s>]/g) ?? []).length === 1],
  ['robots meta', (html) => /<meta name="robots" content="[^"]+"/.test(headOf(html))],
  ['meta description', (html) => /<meta name="description" content="[^"]/.test(headOf(html))],
  ['stylesheet', (html) => /<link rel="stylesheet"/.test(headOf(html))],
  ['one main landmark', (html) => (html.match(/<main[\s>]/g) ?? []).length === 1],
  ['json-ld parses', (html) => {
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!match) return false;
    try {
      JSON.parse(match[1].replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/g, '&'));
      return true;
    } catch {
      return false;
    }
  }],
];

const RULES = previewBuild
  ? [
    ...COMMON_RULES.slice(0, -1),
    ['no canonical in preview', (html) => !headOf(html).includes('rel="canonical"')],
    ['no JSON-LD in preview', (html) => !headOf(html).includes('application/ld+json')],
  ]
  : [
    ...COMMON_RULES,
    releaseConfigured
      ? ['canonical', (html) => (headOf(html).match(/rel="canonical"/g) ?? []).length === 1]
      : ['no canonical without an origin', (html) => !headOf(html).includes('rel="canonical"')],
  ];

if (!fs.existsSync(detailDir)) {
  console.error(`Page parity gate failed: ${path.relative(root, detailDir)} does not exist. Run the build first.`);
  process.exit(1);
}

const counts = { next: 0, lean: 0 };
const failures = [];

for (const item of fs.readdirSync(detailDir, { withFileTypes: true })) {
  if (item.name === 'view') continue;
  if (!item.isDirectory()) {
    failures.push(`/w/${item.name}/ is not a detail directory`);
    continue;
  }

  const dir = path.join(detailDir, item.name);
  const file = path.join(dir, 'index.html');
  const tier = tierOf(dir);
  if (!fs.existsSync(file)) {
    failures.push(`${tier}  /w/${item.name}/ missing: index.html`);
    continue;
  }

  let fileStat;
  try {
    fileStat = fs.lstatSync(file);
  } catch {
    failures.push(`${tier}  /w/${item.name}/ unreadable: index.html`);
    continue;
  }
  if (!fileStat.isFile()) {
    failures.push(`${tier}  /w/${item.name}/ is not a regular file: index.html`);
    continue;
  }

  counts[tier] += 1;
  const html = fs.readFileSync(file, 'utf8');
  for (const [name, holds] of RULES) {
    if (!holds(html)) failures.push(`${tier}  /w/${item.name}/  missing or duplicated: ${name}`);
  }
}

if (counts.next === 0 || counts.lean === 0) {
  console.error(
    `Page parity gate failed: expected both tiers, found ${counts.next} Next and ${counts.lean} lean pages. `
    + 'A gate that only ever sees one tier is not comparing anything.',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`Page parity gate failed on ${failures.length} page(s):`);
  for (const line of failures.slice(0, 20)) console.error(`- ${line}`);
  if (failures.length > 20) console.error(`- ...and ${failures.length - 20} more`);
  process.exit(1);
}

console.log(`Page parity passed: ${counts.next} Next and ${counts.lean} lean detail pages, ${RULES.length} rules each.`);
