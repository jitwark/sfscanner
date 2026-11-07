import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `CI === 'true'` selects the cross-machine budget policy, and that is intended rather than a
// loophole: CI and delegated agent runs share a host with unrelated work, so their micro-latency
// p95 is not comparable evidence. The cross-machine policy still enforces the hard byte ceilings
// and the max-bound deadlines, which are the invariants an automated run can honestly prove.
// See docs/decisions/scanner-v2-performance-budget.md.
const root = resolve(import.meta.dirname, '..'); export const SCANNER_V2_BUDGET_GATE = 'check:scanner-v2-budget'; export const SCANNER_V2_BUDGET_CROSS_MACHINE_GATE = 'check:scanner-v2-budget:cross-machine'; export function selectScannerV2BudgetGate(env = process.env) { return env?.CI === 'true' ? SCANNER_V2_BUDGET_CROSS_MACHINE_GATE : SCANNER_V2_BUDGET_GATE; }
const CORE_GATES = [
  'check:file-size:all',
  'check:specs',
  'check:docs',
  'check:browser-safe',
  'check:contrast',
  'check:accent-usage',
  'check:import-boundary',
  'check:scanner-import-boundary', 'check:scanner-authority',
  'check:regex-safety',
  // `sfscanner`'s four public subpaths resolve through the package `exports` map into
  // `packages/scanner-cli/dist`, and `dist` is gitignored. `typecheck` (pipeline),
  // `check:scanner-parity` and `test` all import those subpaths, so the CLI has to be
  // built first or they fail on a clean checkout. It sits here rather than first so
  // the cheap source-only gates still short-circuit before paying for a build.
  'build:scanner',
  'typecheck',
  'lint',
    'audit',
    'build',
  'check:browser-safe:emitted',
  'check:cli-schemas',
  'check:cli-docs', 'check:scanner-v2-docs', 'check:scanner-source-claims', 'check:scanner-doc-claims', 'check:attribution-basis', 'check:attributions', 'check:scanner-evidence-freshness',
  'check:scanner-reproducibility', 'check:diagnostic-registry',
  'check:scanner-calibration',
  'check:scanner-parity', 'check:scanner-v2-parity',
  'check:scanner-goldens',
  'check:scanner-mutation',
  'check:scanner-docs',
  'check:scanner-core:bare-node',
  'check:scanner-v2-budget',
  'check:search-governance',
    'check:search-quality',
  'check:links',
  'test',
  'test:e2e',
];

/**
 * Gates `CORE_GATES` runs that the standalone scanner repository cannot.
 *
 * That repository ships the scanner source without `data/` — the 13,221-entry
 * corpus is a separate artifact with its own licence — so every gate that reads
 * the corpus, or builds the site from it, can never pass there. Its CI ran
 * `npm run gates` regardless and had therefore never gone green.
 *
 * The value is the reason, so a future reader can tell an intentional omission
 * from an oversight. Anything not listed here is *included* by default: a new
 * gate that needs the corpus will fail the source sequence loudly rather than
 * be silently skipped.
 *
 * `build:scanner` is deliberately not excluded. The standalone repository ships
 * `packages/scanner-cli` — it is the subject of that repository — so the CLI
 * build is available there; only the site build (`build`) needs the corpus.
 * Keeping it also keeps the source sequence self-sufficient: its `typecheck`
 * and `check:scanner-parity` read the packaged subpaths.
 */
const SOURCE_EXCLUDED = Object.freeze({
  'check:specs': 'reads openspec/, which is internal planning and is not published',
  'check:diagnostic-registry': 'reads openspec/ for registry regeneration, which is not published in standalone repository',
  'check:docs': 'compares prose figures against data/analytics.json',
  'check:attribution-basis': 'reads data/analytics.json and the catalogue-derived attribution register, which the standalone scanner repository does not ship',
  'check:attributions': 'regenerates the attribution register from data/catalogue-*.json, which the standalone scanner repository does not ship',
  build: 'builds the site from the corpus',
  'check:browser-safe:emitted': 'inspects the emitted build output',
  'check:search-governance': 'reads search evidence fixtures derived from the corpus',
  'check:search-quality': 'measures ranking against corpus queries',
  'check:scanner-v2-parity': 'drives the app worker and pipeline CLI adapters, which the standalone scanner repository does not ship',
  'check:links': 'resolves links into corpus-generated pages',
  test: 'the app and pipeline suites read the corpus; replaced by test:source',
  'test:e2e': 'drives the built site',
});

/**
 * `test:source` runs only the corpus-independent workspaces — scanner-core,
 * scanner-cli and contracts. That is the whole subject of the public
 * repository, so the sequence still proves the thing it ships.
 */
const SOURCE_GATES = [
  ...CORE_GATES.filter((gate) => !(gate in SOURCE_EXCLUDED)),
  'test:source',
];

export const GATE_SEQUENCES = Object.freeze({
  gates: Object.freeze(CORE_GATES),
  source: Object.freeze(SOURCE_GATES),
  release: Object.freeze([
    ...CORE_GATES,
    'check:corpus',
    // Both read the packaged corpus, so they belong to the release sequence and
    // are excluded from the source one by construction. `check:rights-invariant`
    // is the only thing that proves, against the artifacts rather than the
    // contracts, that a workflow we may not redistribute is never shipped.
    'check:rights-invariant',
    'check:corpus-privacy',
    // The regeneration will derive published facts from genuinely unsanitized
    // official bodies, and the derivations publish credential names and
    // presence booleans, never values. Nothing else measures whether a value
    // gets through: this is the gate that asserts no literal secret value from
    // that corpus appears verbatim in any published artifact. It belongs to
    // `release` for the same reason `check:corpus-privacy` does — it needs both
    // the corpus and the packaged artifacts, so the standalone source sequence
    // cannot run it — and it sits beside corpus-privacy because both are the
    // "what is actually in the bytes we serve" pair.
    'check:published-secret-leak',
    // The declared scanner sidecars are release artifacts the manifest owns; this
    // is the only check that reads their contents, so the release sequence needs it
    // for the same reason it needs `check:data-sync` for their bytes.
    'check:scanner-advisories',

    'check:release',
    'check:data-sync',
    'check:graph',
    'check:catalogue-claim-freshness',
    'check:legal-identity',
    // The last gate: everything above proves its own contract, and this one
    // proves the export still speaks with one configured identity — origin,
    // base path, canonical, structured URLs, robots and sitemap. It fails closed
    // without `NEXT_PUBLIC_SITE_URL`; a local build does not run it.
    'check:web-release',
  ]),
});
export function selectGateSequence(mode, env = process.env) { const sequence = GATE_SEQUENCES[mode]; if (!sequence) throw new Error(`Unknown gate sequence: ${mode}`); const performanceGate = selectScannerV2BudgetGate(env); return sequence.map((command) => command === SCANNER_V2_BUDGET_GATE ? performanceGate : command); }

export const EVIDENCE_FRESHNESS_GATE = 'check:scanner-evidence-freshness';

/**
 * `check:scanner-evidence-freshness` refuses to guess its as-of date, and that refusal is right: a gate
 * that silently reads the wall clock cannot be reproduced or audited. The sequence is what supplies the
 * date. Freshness is a statement about the release moment rather than about the candidate commit — a
 * document written a year before the candidate is not fresh evidence merely because the candidate is
 * old — so the default as-of is the release moment itself. A caller that needs to reproduce an earlier
 * verdict pins `REFERENCE_DATE` (or `SOURCE_DATE_EPOCH`) explicitly and that value wins.
 */
export function gateEnv(command, env = process.env) {
  if (command !== EVIDENCE_FRESHNESS_GATE || env.REFERENCE_DATE || env.SOURCE_DATE_EPOCH) return env;
  return { ...env, REFERENCE_DATE: new Date().toISOString().slice(0, 10) };
}

function runCommand(command) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = command === 'audit' ? ['run', 'check:audit'] : ['run', command];
  try {
    const result = spawnSync(npm, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: gateEnv(command),
    });
    return result.status ?? 1;
  } catch {
    return 1;
  }
}

export function runSequence(commands, runner = runCommand, record) {
  for (const command of commands) {
    const started = Date.now();
    const status = runner(command);
    record?.({ command, status, durationMs: Date.now() - started });
    if (status !== 0) return status;
  }
  return 0;
}

export function createGateSummary({ mode, status, startedAt, finishedAt, durationMs, identities, commands }) {
  return {
    schemaVersion: 'gate-summary-v1',
    mode,
    status: status === 0 ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    durationMs,
    commit: identities.commit,
    release: {
      corpusId: identities.release.corpusId,
      generatedAt: identities.release.generatedAt,
      corpusSha256: identities.release.corpusSha256,
      manifestSha256: identities.release.manifestSha256,
    },
    commands,
  };
}

function readIdentities() {
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const commit = commitResult.status === 0 ? commitResult.stdout.trim() : null;
  try {
    const raw = readFileSync(resolve(root, 'data', 'manifest.json'), 'utf8');
    const metadata = JSON.parse(raw)?.metadata ?? {};
    const text = (value) => (typeof value === 'string' ? value : null);
    const release = {
      corpusId: text(metadata.corpusId), generatedAt: text(metadata.generatedAt), corpusSha256: text(metadata.corpusSha256),
      manifestSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    };
    return { commit, release };
  } catch {
    return { commit, release: { corpusId: null, generatedAt: null, corpusSha256: null, manifestSha256: null } };
  }
}

export function writeGateSummary(summary) {
  const configuredPath = process.env.GATE_SUMMARY_PATH;
  const outputPath = configuredPath ? resolve(root, configuredPath) : resolve(root, 'pipeline', '.work', 'gate-summary.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return outputPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] ?? 'gates';
  const configured = GATE_SEQUENCES[mode];
  if (!configured) {
    console.error(`Unknown gate sequence: ${mode}. Known: ${Object.keys(GATE_SEQUENCES).join(', ')}`); process.exit(2);
  }
  const sequence = selectGateSequence(mode);
  const startedMs = Date.now();
  const commands = [];
  const status = runSequence(sequence, runCommand, (result) => commands.push(result));
  const finishedMs = Date.now();
  const summary = createGateSummary({
    mode,
    status,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
    identities: readIdentities(),
    commands,
  });
  try {
    console.log(`Gate summary written to ${writeGateSummary(summary)}`);
  } catch (error) {
    console.error(`Unable to write gate summary: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  }
  process.exit(status);
}
