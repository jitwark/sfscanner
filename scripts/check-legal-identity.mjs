/**
 * Release gate: fails the real GitHub Pages deploy build if a required legal-
 * identity field in `app/src/ui/legal/legal-contacts.ts` is still `PENDING`,
 * or if `app/src/ui/legal/terms-body.tsx` re-asserts a governing law or
 * jurisdiction the product deliberately does not claim.
 * The product makes no safe-harbour claim, so its optional designated-agent
 * block is deliberately not a production prerequisite.
 *
 * Production signal: `../.github/workflows/deploy.yml` (standalone repo root)
 * is the only place that sets `NEXT_PUBLIC_BASE_PATH` / `NEXT_PUBLIC_SITE_URL`
 * — as job-level env, before it runs `npm run release:gates`. `ci.yml`'s
 * per-push `gates` job never sets either, and neither does any local dev,
 * test, or build invocation. That makes their presence this repo's actual
 * "this is a production deploy" signal — not `NODE_ENV`, which is
 * `'production'` for every `next build`, including this script's own local
 * runs during this session.
 *
 * Deliberately does not `import()` legal-contacts.ts: `check:*` scripts stay
 * plain-node with no build/transpile step (see vitest.config.ts's "scripts"
 * project and pipeline/check-browser-safe.mjs's static source sweep), so this
 * reads the file as text via scripts/lib/legal-identity.mjs instead.
 *
 * Wired into `release:gates` only, not `gates` — a placeholder legal identity
 * must not fail every push, only the deploy that would actually publish it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  findProductionLegalReleaseFailures,
  isProductionRelease,
} from './lib/legal-identity.mjs';

const root = path.resolve(import.meta.dirname, '..');
const targetFile = path.join(root, 'app', 'src', 'ui', 'legal', 'legal-contacts.ts');
const termsFile = path.join(root, 'app', 'src', 'ui', 'legal', 'terms-body.tsx');
const decisionFile = path.join(root, 'docs', 'legal', 'OWNER-DECISION-PACKET.md');
const relativeTarget = path.relative(root, targetFile).replaceAll('\\', '/');
const relativeTerms = path.relative(root, termsFile).replaceAll('\\', '/');
const relativeDecision = path.relative(root, decisionFile).replaceAll('\\', '/');

if (!isProductionRelease(process.env)) {
  console.log(
    'check:legal-identity skipped — NEXT_PUBLIC_BASE_PATH/NEXT_PUBLIC_SITE_URL not set, ' +
      'so this is not the production deploy build.',
  );
  process.exit(0);
}

if (!fs.existsSync(targetFile)) {
  console.error(`check:legal-identity failed: ${relativeTarget} not found.`);
  process.exit(1);
}

if (!fs.existsSync(decisionFile)) {
  console.error(`check:legal-identity failed: ${relativeDecision} not found.`);
  process.exit(1);
}

if (!fs.existsSync(termsFile)) {
  console.error(`check:legal-identity failed: ${relativeTerms} not found.`);
  process.exit(1);
}

const failures = findProductionLegalReleaseFailures({
  legalIdentitySource: fs.readFileSync(targetFile, 'utf8'),
  decisionPacketSource: fs.readFileSync(decisionFile, 'utf8'),
  termsBodySource: fs.readFileSync(termsFile, 'utf8'),
});

if (failures.length > 0) {
  console.error(
    `check:legal-identity failed — production release prerequisites are not satisfied:`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\nComplete the legal identity in ${relativeTarget}, remove any unsupported jurisdiction claim from ${relativeTerms}, and record explicit approval in ${relativeDecision}.`,
  );
  process.exit(1);
}

console.log(
  `check:legal-identity passed — legal identity is complete and production promotion is explicitly approved.`,
);
