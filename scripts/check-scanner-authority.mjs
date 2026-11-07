/**
 * Sole-authority gate for the scanner.
 *
 * The plan row is "make `packages/scanner-core` the only parser/policy/analyzer/redaction
 * authority". Two implementations of one responsibility can disagree, and the app-local layer did:
 * `app/src/scanner/taint-expressions.ts` parsed expressions with a bare Acorn `parse()` while core's
 * authority had moved to the depth-guarded `parseExpression`, and the app-local lattice never froze
 * a published state. This check makes the *declaration* of each responsibility a single file, so a
 * reintroduced copy fails here instead of drifting quietly.
 *
 * Most entries are the responsibilities the plan row names; the last three were pinned when the
 * 5.2 follow-up collapsed duplicate implementations the row did not cover (see
 * `AUTHORITY_DECLARATIONS`).
 *
 * It asserts declarations, not occurrences: an adapter may import, re-export or cast an authority
 * (`app/src/scanner/scanner-core-adapter.ts` does all three), but it may not redeclare it.
 *
 * After packet 5.2c deleted `app/src/workflow/**` and the app-local policy/vocabulary/taint copies,
 * the `app/src` entries below are reintroduction guards: the reviewed roots still include the tree
 * so a second implementation cannot come back unnoticed.
 *
 * Usage: node scripts/check-scanner-authority.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Roots whose production sources may not declare a scanner authority. */
export const REVIEWED_ROOTS = Object.freeze([
  'app/src',
  'packages/scanner-core/src',
  'packages/scanner-cli/src',
  'pipeline',
  'contracts',
]);

/**
 * One entry per responsibility the plan row names. `signature` is the *declaration* form, so a
 * caller, a type re-export or a comment cannot satisfy it.
 */
export const AUTHORITY_DECLARATIONS = Object.freeze([
  { responsibility: 'workflow parsing', signature: 'export function parseWorkflowJson', authority: 'packages/scanner-core/src/workflow.ts' },
  { responsibility: 'workflow fingerprinting', signature: 'export function fingerprintJson', authority: 'packages/scanner-core/src/workflow.ts' },
  { responsibility: 'workflow graph construction', signature: 'export function buildWorkflowGraph', authority: 'packages/scanner-core/src/workflow-graph.ts' },
  { responsibility: 'policy types and diagnostic vocabulary', signature: 'export const ANALYSIS_DIAGNOSTIC_CODES', authority: 'packages/scanner-core/src/policy/policy.ts' },
  { responsibility: 'completeness classification', signature: 'export const ANALYSIS_DIAGNOSTIC_COMPLETENESS', authority: 'packages/scanner-core/src/result/analysis-completeness.ts' },
  { responsibility: 'completeness classification', signature: 'export function classifyAnalysisStatus', authority: 'packages/scanner-core/src/result/analysis-completeness.ts' },
  { responsibility: 'rule vocabulary', signature: 'export const betaDefaultRuleCatalog', authority: 'packages/scanner-core/src/policy/rule-catalog.ts' },
  { responsibility: 'rule vocabulary', signature: 'export const betaHardenedRuleCatalog', authority: 'packages/scanner-core/src/policy/rule-catalog.ts' },
  { responsibility: 'rule vocabulary', signature: 'export const TAINT_POLICY_IDS', authority: 'packages/scanner-core/src/policy/rule-catalog.ts' },
  { responsibility: 'policy evaluation', signature: 'export function resolvePolicyProfile', authority: 'packages/scanner-core/src/policies/profile.ts' },
  { responsibility: 'taint analysis', signature: 'export const TAINT_LABELS', authority: 'packages/scanner-core/src/analyzers/taint/taint-lattice.ts' },
  { responsibility: 'taint analysis', signature: 'export function joinTaintStates', authority: 'packages/scanner-core/src/analyzers/taint/taint-lattice.ts' },
  { responsibility: 'expression parsing', signature: 'export function readParameterExpressions', authority: 'packages/scanner-core/src/analyzers/taint/taint-expressions.ts' },
  { responsibility: 'taint analysis', signature: 'export function analyzeWorkflowTaint', authority: 'packages/scanner-core/src/analyzers/taint/taint-analysis.ts' },
  { responsibility: 'AI capability analysis', signature: 'export function analyzeAiCapabilities', authority: 'packages/scanner-core/src/analyzers/ai/ai-capability-analysis.ts' },
  { responsibility: 'JavaScript analysis', signature: 'export function analyzeWorkflowJavaScript', authority: 'packages/scanner-core/src/analyzers/code/javascript-analysis.ts' },
  { responsibility: 'Python analysis', signature: 'export function analyzeWorkflowPython', authority: 'packages/scanner-core/src/analyzers/code/python-analysis.ts' },
  { responsibility: 'redaction', signature: 'export function redactText', authority: 'packages/scanner-core/src/redaction/redaction.ts' },
  { responsibility: 'redaction', signature: 'export function redactEvidence', authority: 'packages/scanner-core/src/redaction/redaction.ts' },
  { responsibility: 'redaction', signature: 'export function redactWorkflowJson', authority: 'packages/scanner-core/src/redaction/redaction.ts' },
  { responsibility: 'redaction', signature: 'export function redactFinding', authority: 'packages/scanner-core/src/redaction/redaction.ts' },
  // Pinned by the 5.2 follow-up: the v1 failure-vs-omission ladder, the v1 finding-to-source span
  // attachment and the v2 SARIF document each had two implementations (`.superpowers/sdd/
  // task-5.2-report.md` findings 1-3). Each is now declared in exactly one file, and a
  // reintroduced copy fails here rather than drifting silently.
  { responsibility: 'required-stage failure ladder', signature: 'export function asRequiredStageFailure', authority: 'packages/scanner-core/src/result/analysis-completeness.ts' },
  { responsibility: 'finding source-span attachment', signature: 'export function attachFindingSourceSpans', authority: 'packages/scanner-core/src/result/finding-source-spans.ts' },
  { responsibility: 'v2 SARIF document', signature: 'export function buildBatchSarifV2', authority: 'packages/scanner-core/src/report/sarif-v2/output.ts' },
  // The next two are the same responsibility's other names. `buildSarifV2` is the name an earlier
  // duplicate used, so pinning only the public `buildBatchSarifV2` would let a re-written copy return
  // unnoticed. Both are internal aliases in the core module rather than advertised exports, which
  // means removing or renaming one there fails this gate with MISSING_AUTHORITY: that is the intended
  // outcome, and the response is to update this list in the same change, not to delete the pin.
  { responsibility: 'v2 SARIF document', signature: 'export function buildSarifV2', authority: 'packages/scanner-core/src/report/sarif-v2/output.ts' },
  { responsibility: 'v2 SARIF document', signature: 'export function serializeSarifV2', authority: 'packages/scanner-core/src/report/sarif-v2/output.ts' },
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

function isTestOrFixture(relativePath) {
  const filename = relativePath.split('/').at(-1) ?? '';
  return relativePath.split('/').some((part) => part === '__fixtures__' || part === 'fixtures' || part === '.work')
    || /\.(?:test|spec)\.[^.]+$/.test(filename);
}

function collectProductionFiles(directory, root, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) { collectProductionFiles(full, root, files); continue; }
    const relativePath = relative(root, full).replace(/\\/g, '/');
    if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !isTestOrFixture(relativePath)) files.push(full);
  }
}

export function collectReviewedFiles(root) {
  const files = [];
  for (const directory of REVIEWED_ROOTS) collectProductionFiles(join(root, directory), root, files);
  return files.sort();
}

const escapedSignature = (signature) => signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A declaration is the signature at the start of a line, immediately followed by its `(` (function),
 * `<` (generic function), `=` (const) or `:` (annotated const). Prose in a comment, an import, or a
 * doc-comment mention has a word after the name instead, so it cannot be mistaken for a second
 * declaration.
 */
const declarationPattern = (signature) => new RegExp(`^\\s*${escapedSignature(signature)}\\s*[:=(<]`, 'm');

/** Every file under the reviewed roots that declares `signature`, as repo-relative paths. */
export function declarationSites(root, signature, files = collectReviewedFiles(root)) {
  const pattern = declarationPattern(signature);
  return files
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).replace(/\\/g, '/'))
    .sort();
}

/** `{ responsibility, signature, declaredBy }` for each violation, plus missing authorities. */
export function findAuthorityViolations(root, declarations = AUTHORITY_DECLARATIONS) {
  const files = collectReviewedFiles(root);
  const violations = [];
  for (const declaration of declarations) {
    const sites = declarationSites(root, declaration.signature, files);
    if (sites.length === 0) {
      violations.push({ kind: 'MISSING_AUTHORITY', ...declaration, declaredBy: [] });
      continue;
    }
    for (const site of sites) {
      if (site !== declaration.authority) violations.push({ kind: 'DUPLICATE_AUTHORITY', ...declaration, declaredBy: sites });
    }
  }
  return violations;
}

export function formatAuthorityViolation(violation) {
  const declared = violation.declaredBy.join(', ') || 'nothing';
  const detail = violation.kind === 'MISSING_AUTHORITY'
    ? `no reviewed production file declares '${violation.signature}' (expected ${violation.authority})`
    : `'${violation.signature}' is declared by ${declared}; the only ${violation.responsibility} authority is ${violation.authority}`;
  return `  - ${violation.responsibility}: ${detail}`;
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findAuthorityViolations(root);
  if (violations.length > 0) {
    console.error(`Scanner authority check failed (${violations.length} violation(s) of ${AUTHORITY_DECLARATIONS.length} declarations):`);
    for (const violation of violations) console.error(formatAuthorityViolation(violation));
    process.exitCode = 1;
  } else {
    const files = collectReviewedFiles(root).length;
    console.log(`Scanner authority passed: ${AUTHORITY_DECLARATIONS.length} declarations over ${files} reviewed production file(s) in ${REVIEWED_ROOTS.length} root(s).`);
  }
}
