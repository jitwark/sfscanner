/**
 * Gate: no literal secret value from the unsanitized official corpus reaches a
 * published artifact.
 *
 * The regeneration derives published facts from genuinely unsanitized bodies,
 * and the derivations publish credential *names* and *presence booleans*, never
 * values. Nothing measured whether a value gets through. This does.
 *
 *   raw official bodies → candidate values (strict + widened sweep)
 *                       → byte-scan every published artifact
 *                       → zero verbatim matches, or a finding
 *
 * The strict rule set is the assertion; the loose set is the widened sweep and
 * is reported separately because the two differ by two orders of magnitude and
 * only the strict set is defensible as "a secret".
 *
 * **This gate never prints a candidate value.** A leak gate that logs the
 * secret it found has published it a second time, into output retained for
 * weeks, so findings are the artifact, the field path and the rule class.
 *
 * A positive control runs on every invocation: synthetic values are planted in
 * a temporary artifact and the real sweep must detect them, or the gate fails.
 * A leak gate that has only ever passed is not evidence.
 *
 * Usage:
 *   node scripts/check-published-secret-leak.mjs [--bodies <dir>] [--artifacts <dir>[;<dir>...]]
 *                                               [--snapshot <file>] [--plant-leak] [--json]
 *
 * `--snapshot` (or `OFFICIAL_BODIES_SNAPSHOT`) is the verified input snapshot —
 * `{schemaVersion, algorithm, inventoryDigest, fileCount, totalBytes, files[]}` —
 * that every body read must match, file by file. A missing, altered or unreadable
 * snapshot fails closed before any artifact is compared; the strict and loose
 * sweeps and the positive control still decide the verdict, and no body value is
 * ever printed, logged or persisted.
 *
 * `--plant-leak` adds the control's own synthetic artifact to the sweep so the
 * gate fails on demand; it exists to demonstrate the red verdict and is never
 * part of the sequence.
 *
 * Bodies default to `OFFICIAL_BODIES_DIR`, or private repository-local storage
 * `<workspace>/.work/inputs/official`; no parent checkout or sibling layout is assumed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNeedles, collectCandidates, createCandidateIndex } from './lib/published-secret-candidates.mjs';
import { absentBodiesOutcome, resolveBodiesDirectory } from './lib/local-only-corpus-policy.mjs';
import { bindBodiesToInventory, readInputSnapshot } from './lib/published-secret-input-inventory.mjs';
import { MIN_SWEEP_LENGTH, resolveMatches, sweepArtifacts } from './lib/published-secret-sweep.mjs';
import { runPositiveControl } from './lib/published-secret-positive-control.mjs';
import {
  artifactSet,
  ARTIFACT_ROOTS,
  relative,
  renderFindings,
  renderSummary,
  reportMatches,
  summarizeNeedles,
} from './lib/published-secret-report.mjs';

const root = path.resolve(import.meta.dirname, '..');

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** Every fail-closed exit reads the same, so the reason is the only variable. */
function failClosed(detail) {
  console.error(`Published secret gate failed: ${detail}`);
  console.error('This gate fails closed: input it cannot identify as the authorized corpus proves nothing.');
  process.exit(1);
}

async function main() {
  const json = hasFlag('json');
  /** In `--json` mode stdout is the machine-readable report and nothing else. */
  const log = json ? console.error : console.log;
  const bodiesDir = resolveBodiesDirectory({ root, override: flag('bodies') });

  if (!fs.existsSync(bodiesDir)) {
    const absent = absentBodiesOutcome({ root, bodiesDir, ci: process.env.CI });
    if (absent.action === 'skip') {
      log(absent.message);
      process.exit(0);
    }
    for (const line of absent.lines) console.error(line);
    process.exit(1);
  }

  /** The record is checked first: a missing or incoherent snapshot stops the run before a body is read. */
  const snapshotPath = flag('snapshot') ?? process.env.OFFICIAL_BODIES_SNAPSHOT;
  const snapshot = readInputSnapshot(snapshotPath ? path.resolve(snapshotPath) : undefined);
  if (!snapshot.ok) failClosed(snapshot.detail);

  /**
   * Extraction is bound to the verified inventory per file: one read, hashed and
   * parsed from that same buffer, nothing retained between files. An added,
   * removed, altered or unreadable body stops the run before any artifact is
   * compared; a body that will not parse is a failure, not a skip.
   */
  const candidateIndex = createCandidateIndex();
  const unparsable = [];
  const extraction = bindBodiesToInventory({
    bodiesDir,
    inventory: snapshot.inventory,
    consume: (name, content) => {
      let body;
      try {
        body = JSON.parse(content.toString('utf8'));
      } catch {
        unparsable.push(name);
        return;
      }
      collectCandidates(body, name, candidateIndex);
    },
  });
  if (!extraction.ok) failClosed(extraction.detail);

  const bodies = extraction.names;
  log(`Input snapshot: ${snapshot.inventory.digest} verified over ${bodies.length} bodies / ${snapshot.inventory.totalBytes} bytes`);
  log(`  snapshot: ${relative(root, snapshot.snapshotPath)}`);

  if (bodies.length === 0 || unparsable.length > 0) {
    console.error(`Published secret gate failed: ${bodies.length} bodies found, ${unparsable.length} unparsable.`);
    console.error(`Unparsable: ${unparsable.slice(0, 10).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const needles = buildNeedles(candidateIndex);
  const { sweepNeedles, strict, loose, belowFloor } = summarizeNeedles(needles, MIN_SWEEP_LENGTH);

  const control = await runPositiveControl({ retainArtifacts: hasFlag('plant-leak') });
  const artifacts = artifactSet({ root, override: flag('artifacts') });
  /**
   * A vacuous pass is worse than a red gate: if no artifact was read, "no candidate
   * appears in a published artifact" is not a claim this run is entitled to make.
   */
  if (artifacts.files.length === 0) {
    console.error('Published secret gate failed: no published artifacts were found to sweep.');
    console.error(
      artifacts.present.length === 0
        ? `None of the roots exist: ${ARTIFACT_ROOTS.join(', ')}.`
        : `Roots present but empty: ${artifacts.present.map((entry) => relative(root, entry)).join(', ')}.`,
    );
    process.exit(1);
  }
  /**
   * `--plant-leak` merges the control's own synthetic needles and artifact into
   * this run, so the gate's verdict path is exercised end to end. It never plants
   * a value from the corpus: persisting one to demonstrate the gate would break
   * the gate's own rule.
   */
  const planted = control.plantedNeedles ?? [];
  const plantedOffset = sweepNeedles.length;
  const effectiveNeedles = [...sweepNeedles, ...planted.map((needle, position) => ({ ...needle, id: plantedOffset + position }))];
  const sweepFiles = [...artifacts.files, ...(control.artifactFiles ?? [])];
  const matches = await sweepArtifacts({ files: sweepFiles, needles: effectiveNeedles });
  const { strict: strictMatches, looseOnly: looseMatches } = reportMatches({ matches, needles: effectiveNeedles, root, resolve: resolveMatches });

  /**
   * The control's own needles are held out of the published summary: a report is
   * not a place a value appears, even a synthetic one.
   */
  const controlReport = { ...control };
  delete controlReport.plantedNeedles;
  const summary = {
    bodiesDir: relative(root, bodiesDir),
    bodiesScanned: bodies.length,
    bodiesUnparsable: unparsable.length,
    inputSnapshot: {
      digest: snapshot.inventory.digest,
      fileCount: snapshot.inventory.fileCount,
      totalBytes: snapshot.inventory.totalBytes,
      algorithm: snapshot.inventory.algorithm,
      schemaVersion: snapshot.inventory.schemaVersion,
      snapshot: relative(root, snapshot.snapshotPath),
    },
    candidates: {
      strict: { distinctValues: strict.distinctValues, valuesByRule: strict.valuesByRule, fieldPaths: strict.fieldPaths, sourceBodies: strict.sources.length },
      loose: { distinctValues: loose.distinctValues, valuesByRule: loose.valuesByRule, fieldPaths: loose.fieldPaths, sourceBodies: loose.sources.length },
      belowSweepFloor: belowFloor,
      sweepFloor: MIN_SWEEP_LENGTH,
      distinctNeedles: needles.length,
      needlesSwept: sweepNeedles.length,
    },
    artifactsSwept: {
      roots: artifacts.present.map((entry) => relative(root, entry)),
      missingRoots: artifacts.missing,
      files: artifacts.files.length,
      bytes: artifacts.bytes,
      plantedControlFiles: control.artifactFiles?.length ?? 0,
    },
    positiveControl: controlReport,
    matches: { strict: strictMatches.length, looseOnly: looseMatches.length },
    findings: { strict: strictMatches, looseOnly: looseMatches },
  };

  if (json) console.log(JSON.stringify(summary, null, 2));
  else log(renderSummary(summary));

  /**
   * Findings print in both modes. A red gate that only named its locations in the
   * human-readable mode would be unreadable exactly where it matters — in the
   * sequence, where the summary is machine-read and the failure still has to be
   * actionable.
   */
  const findings = renderFindings(summary.findings);
  if (findings) console.error(findings);

  if (control.directory) fs.rmSync(control.directory, { recursive: true, force: true });

  if (strictMatches.length > 0) {
    console.error(
      `Published secret gate failed: ${strictMatches.length} strict candidate value(s) appear ` +
      'verbatim in a published artifact. Field paths above; no value is printed.',
    );
    process.exit(1);
  }
  log(
    `Published secret gate passed: 0 verbatim strict matches across ${artifacts.files.length} ` +
    `published artifacts; ${looseMatches.length} widened-sweep match(es) reported and not asserted.`,
  );
  return 0;
}

await main();
