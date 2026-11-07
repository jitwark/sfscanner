import fs from 'node:fs';
import path from 'node:path';

// This module is the versioned, reviewable declaration of what the public
// extraction selects (DEFAULT_PUBLIC_ALLOWLIST) and what the approved
// standalone tree (docs/plans/2026-09-04-production-readiness-programme.md,
// Phase 5) requires to exist at all (PHASE7_REQUIRED_TREE). Changing either is a reviewable diff, not a silent
// edit inside the extractor's control flow.
export const ALLOWLIST_SCHEMA_VERSION = 'public-repo-allowlist-v1';
export const REQUIRED_TREE_SCHEMA_VERSION = 'public-repo-required-tree-v1';

// These paths are deliberately excluded even when their parent source tree is
// selected. They contain acquired workflow bodies or local fixture corpora,
// not source required to build the public application.
export const DEFAULT_PUBLIC_EXCLUSIONS = Object.freeze([
  'app/src/scanner/__fixtures__/calibration-corpus',
  'app/src/scanner/__fixtures__/calibration-corpus.test.ts',
  // Captured templates and upstream .ee workflow bodies are private audit inputs,
  // not redistributable scanner source. This unused fixture tree has no consumers.
  'app/src/scanner/__fixtures__/n8n-exports',
  'app/src/scanner/__fixtures__/n8n-graph-exports',
  'app/src/scanner/n8n-graph-fixture.test.ts',
  'pipeline/scan/scanner-input-differential.test.ts',
  'pipeline/scan/__fixtures__/f1804862f3d4c9f7.json',
  'pipeline/acquire/__fixtures__/real-cocktail.json',
  'pipeline/acquire/__fixtures__/real-telegram.json',
  'pipeline/acquire/__fixtures__/real-weather.json',
  'app/app/.next',
  'contracts/node_modules',
  'packages/scanner-cli/dist',
  'packages/scanner-cli/src/graft/.cache',
  'packages/scanner-core/src/graft/.cache',
  'app/src/scanner/graft/.cache',
  'packages/scanner-cli/node_modules',
  'packages/scanner-core/node_modules',
  'pipeline/.work',
  'pipeline/pipeline/.work',
  'pipeline/node_modules',
  'pipeline/tsconfig.tsbuildinfo',
  // Generated public assets are ignored by Git and cannot be reproduced by a
  // clean public checkout. Keep the real app source and test fixtures.
  'app/app/public',
  'contracts/tsconfig.tsbuildinfo',
  'pipeline/__fixtures__/make-entry.d.ts',
  // Acquisition/evaluation reports are internal run output, not public source.
  'pipeline/reports',
  'scripts/firebase-preview-config.test.mjs',
  'scripts/lib/firebase-preview.mjs',
  'scripts/lib/firebase-preview.test.mjs',
  'app/app/page.test.tsx',
  'app/src/catalogue/download-http.test.ts',
  'app/src/catalogue/link-graph.test.ts',
  'app/src/catalogue/manifest.test.ts',
  'app/src/catalogue/prerender-list.test.ts',
  'app/src/search/search-client.test.ts',
  'app/src/search/worker-committed-data.test.ts',
  'app/src/search/worker-release-contract.test.ts',
  'app/src/ui/workflow-chart.corpus.test.tsx',
  // Reads the committed preview records in `data/previews/`, which the public
  // tree does not ship (the corpus is a separate licensed artifact), so it can
  // never run in the standalone repository's `test:source` sequence.
  'contracts/svg-preview.test.ts',
  'scripts/budget-margin.test.mjs',
  'scripts/check-scanner-calibration.test.mjs',
  'scripts/lib/scanner-result-schema-migration.test.mjs',
  'scripts/deploy-firebase-preview.mjs',
  '.npmrc',
  'action.yml',
]);

// These paths are denied after traversal as well as during selected-only
// traversal, because a broad allowlist such as `.` must not make credentials
// or deployment machinery eligible for materialization.
export const PUBLIC_REPO_FAIL_CLOSED_PATHS = Object.freeze([
  '.npmrc',
  'action.yml',
  'scripts/deploy-firebase-preview.mjs',
]);

export const DEFAULT_PUBLIC_ALLOWLIST = Object.freeze([
  // The prepared composite GitHub Action lives under the conventional action
  // path. The legacy root action is intentionally not extracted because it
  // invokes the unpublished pipeline adapter and has no workspace path gate.
  '.github/actions/scan/action.yml',
  // The public extraction selects the standalone source tree and excludes
  // generated, private, and acquired workflow data through DEFAULT_PUBLIC_EXCLUSIONS.
  '.gitattributes', '.github/ISSUE_TEMPLATE', '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows', '.gitignore', 'app/app', 'app/eslint.config.mjs', 'app/next.config.ts',
  'app/package.json', 'app/postcss.config.mjs', 'app/src', 'app/tsconfig.json', 'app/vitest.config.ts',
  'app/public/third-party-notices.txt', 'docs/third-party',
  'ATTRIBUTIONS.md', 'CODEOWNERS', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'contracts', 'DATA-LICENSE.md', 'docs/ARCHITECTURE.md', 'docs/CLI.md',
  'docs/CONTENT-CONTRACT.md', 'docs/DATA-AVAILABILITY.md', 'docs/DATA-LIFECYCLE.md', 'docs/DATA-RELEASE-RETENTION.md', 'docs/LICENSING.md',
  'docs/perf/budgets.json', 'docs/search-quality-thresholds.json',
  'app/qa',
  'docs/SECURITY.md', 'docs/privacy.md',
  // The whole scanner documentation directory, not a file list. It is the
  // product's most valuable artifact and it grew four documents in one day;
  // enumerating it meant new pages silently failed to publish.
  'docs/scanner',
  'docs/scanner-false-positive-review.md',
  // Decisions, and the two policies a reader needs to trust the catalogue:
  // where model output is permitted, and how search quality is measured.
  'docs/decisions', 'docs/DESIGN.md', 'docs/README.md',
  'docs/ENRICHMENT-POLICY.md', 'docs/SEARCH-QUALITY.md',
  'CHANGELOG.md', 'SOURCE.md',
  // The end-to-end specs. They cannot run in the standalone repository, which
  // ships no corpus, but a reader evaluating a security tool should be able to
  // read what it claims to verify.
  'app/e2e', 'app/playwright.config.ts',
  'docs/sources.md', 'docs/takedown.md', 'eslint.config.mjs', 'LICENSE', 'package-lock.json',
  'package.json', 'packages', 'pipeline', 'README.md', 'SECURITY.md', 'GOVERNANCE.md', 'THIRD_PARTY_NOTICES.md', 'examples', 'scripts',
  // The versioned JSON Schemas the scanner validates against. They are shipped
  // source, not generated output: `contracts/scanner-v2-result.test.ts`, the
  // scanner-core trust-store and target-context suites and
  // `check:scanner-v2-docs` all read `schemas/*.json` directly, so leaving the
  // directory out made five source-gate steps fail in the standalone tree.
  'schemas',
  'tsconfig.json', 'vitest.config.ts',
]);

// The approved Phase 7 standalone tree (P7.5). Every entry is a path this
// workspace must eventually contain for extraction to produce the required
// shape. Existence is checked at run time by findMissingRequiredPaths — this
// list itself never silently drops an entry just because the path is absent
// today.
export const PHASE7_REQUIRED_TREE = Object.freeze([
  { path: '.github/workflows', description: 'CI workflow definitions for the standalone repository.' },
  { path: 'app', description: 'The static site.' },
  { path: 'packages/scanner-core', description: 'Browser-safe scanner core package.' },
  { path: 'packages/scanner-cli', description: 'Offline scanner CLI package (Phase 7 P7.1/P7.2).' },
  { path: 'pipeline', description: 'Corpus acquisition/sanitize/scan pipeline.' },
  { path: 'contracts', description: 'Shared canonical contracts and serialization.' },
  { path: 'docs', description: 'Public documentation.' },
  { path: 'examples', description: 'Synthetic example workflows with focused integrity validation (P7.4).' },
  { path: 'scripts', description: 'Build/release/extraction tooling.' },
  { path: 'README.md', description: 'Root README (P7.6 structure).' },
  { path: 'LICENSE', description: 'Code licence.' },
  { path: 'docs/LICENSING.md', description: 'Authoritative code and catalogue licensing policy.' },
  { path: 'SECURITY.md', description: 'Root security policy: supported versions, private reporting, response expectations.' },
  { path: 'CONTRIBUTING.md', description: 'Root contribution rules and review expectations.' },
  { path: 'CODE_OF_CONDUCT.md', description: 'Community conduct policy referenced by Phase 7 P7.5.' },
  { path: 'GOVERNANCE.md', description: 'Root maintainers/decision/release process.' },
  { path: 'CODEOWNERS', description: 'Reviewer coverage for scanner policies, rights/data, security, release, legal docs.' },
  { path: 'ATTRIBUTIONS.md', description: 'Upstream notices and modification statements.' },
  { path: 'THIRD_PARTY_NOTICES.md', description: 'Third-party licence notices.' },
  { path: 'package.json', description: 'Root package manifest.' },
  { path: 'package-lock.json', description: 'Locked dependency graph.' },
]);

// Kept as a versioned extension point for callers that render structural
// findings. The standalone CLI now exists at the required path, so this
// release has no known path substitution to report.
export const STRUCTURAL_GAPS = Object.freeze([]);

export function findMissingRequiredPaths(repositoryRoot) {
  const root = path.resolve(repositoryRoot ?? process.cwd());
  return PHASE7_REQUIRED_TREE
    .filter((entry) => !fs.existsSync(path.resolve(root, entry.path)))
    .map((entry) => ({ path: entry.path, description: entry.description }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
