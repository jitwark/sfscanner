import fs from 'node:fs';
import path from 'node:path';
import { runRegeneration, type RegenerationReport } from './run-regeneration.js';

/**
 * Run the unified whole-corpus regeneration and write one complete release tree.
 *
 *   npx tsx pipeline/regenerate/cli.ts \
 *     --bodies "D:/projects/n8n templates/04_curated_official_and_github/official" \
 *     --bodies "D:/projects/n8n templates/05_backfilled_official" \
 *     --generated-at 2026-09-25T00:00:00.000Z \
 *     --out pipeline/.work/regeneration/run-bodies/data \
 *     --legacy-stamp c998701
 *
 * `--bodies` may be repeated and each folder is read for the bodies the map
 * recorded in it; the declaration must be exactly the folders the map bound.
 * Nothing under `data/` is touched: the tree is written to `--out` and promoted
 * separately with `node scripts/prepare-release-data.mjs <out> --replace`.
 * `--generated-at` is required rather than defaulted to the wall clock, because
 * two runs over the same inputs and the same timestamp must produce byte-identical
 * artifacts and that is only provable if the clock is an argument.
 *
 * The staging directory is deliberately named `data`: `buildMetadataFromEntries`
 * stamps `corpusId` from the output directory's last segment, so a path ending in
 * anything else would publish the wrong corpus identity.
 *
 * ## Report schema — `corpus-regeneration-v1`
 *
 * Written to `--report`, defaulting to `<out>/../regeneration-report.json`. In
 * addition to the run counts and readiness census, it carries two ledgers whose
 * contents are derived from the run and never hard-coded:
 *
 *  - `unparseable[]` — one row per upstream fixture whose stored body failed
 *    `parseWorkflowJson`, ascending by template id: `entryId`, `templateId`,
 *    `slug`, the parser's `reason` (a `WorkflowParseErrorCode`, e.g.
 *    `MALFORMED_WORKFLOW`), the published `analysisStatus` (`INDETERMINATE`),
 *    `grade` (`UNKNOWN`), `findings` (0) and the `scannerVersion`/`profile` that
 *    produced that verdict. The failure is observed at the scan (`onUnparseable`)
 *    rather than inferred from the published state, where another scan failure
 *    would look identical. An empty array means every body read parsed.
 *  - `redistributableBodies` — the sorted inventory of redistributable sanitized
 *    bodies: `count`, `totalBytes` and `rows[]` of `{ path, line, bytes, sha256 }`,
 *    each recomputed from the packed record. `count` is asserted equal to
 *    `counts.redistributableLabelsOnly`, so the inventory cannot silently disagree
 *    with the entry classification.
 *
 * The same inventory is also written, byte-for-byte sorted, to
 * `<reportDir>/redistributable-body-inventory.json` so a gate can consume it
 * without parsing the whole report.
 *
 * ## Redistribution claims
 *
 * `rights.status` is copied from the frozen catalogue verbatim, so a run that
 * republishes `redistributable` republishes the claim with it. Every such
 * claim is checked against the recorded per-item licence evidence in the
 * rights-evidence journal before anything is written; `--rights-evidence`
 * names it and defaults to `<dataDir>/rights-evidence.jsonl`. A claim whose
 * evidence the journal does not support fails the run and names the entries,
 * and the report carries `redistributionEvidence` with the counts actually
 * checked. Passing a path that does not exist is a failure, not an empty
 * journal.
 */
type CliArguments = {
  bodySources: string[];
  generatedAt: string;
  out: string;
  data: string;
  map: string;
  report?: string;
  rightsEvidence?: string;
  legacyStamps: string[];
};

function parseArguments(argv: string[]): CliArguments {
  const values = new Map<string, string>();
  const legacyStamps: string[] = [];
  const bodySources: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    index += 1;
    if (name === 'legacy-stamp') legacyStamps.push(value);
    else if (name === 'bodies') bodySources.push(value);
    else values.set(name, value);
  }
  const generatedAt = values.get('generated-at');
  const out = values.get('out');
  if (bodySources.length === 0) throw new Error('--bodies <dir> is required at least once: the map cannot guess where the bodies live');
  if (!generatedAt) throw new Error('--generated-at <iso> is required (a stage body never reads the clock)');
  if (!out) throw new Error('--out <dir> is required');
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('--generated-at must be an ISO timestamp');
  const data = values.get('data') ?? 'data';
  const outResolved = path.resolve(out);
  if (path.resolve(data) === outResolved) throw new Error('--out must not be the source corpus');
  if (path.basename(outResolved) !== 'data') {
    throw new Error(`--out must end in a directory named "data" so corpusId is published as "data" (got ${path.basename(outResolved)})`);
  }
  return {
    bodySources,
    generatedAt,
    out,
    data,
    map: values.get('map') ?? path.join('pipeline', '.work', 'official-body-map.json'),
    ...(values.get('report') ? { report: values.get('report')! } : {}),
    ...(values.get('rights-evidence') ? { rightsEvidence: values.get('rights-evidence')! } : {}),
    legacyStamps,
  };
}

function report(reportValue: RegenerationReport): string {
  const { counts } = reportValue;
  const unparseable = reportValue.unparseable;
  const inventory = reportValue.redistributableBodies;
  return [
    `Official-body map: matched ${reportValue.mapCounts.matched}, without body ${reportValue.mapCounts.withoutBody},`,
    `  orphan bodies ${reportValue.mapCounts.orphanBodies}, body files ${reportValue.mapCounts.bodyFiles}`,
    `Regenerated: ${counts.reDerived} re-derived from a body, ${counts.labelsOnly} labels-only`,
    `  official without a body: ${counts.officialWithoutBody}`,
    `  redistributable with a committed (sanitized) body: ${counts.redistributableLabelsOnly}`,
    `  GitHub link-only without a body: ${counts.linkOnlyGithubLabelsOnly}`,
    `Readiness: ${reportValue.readiness.derived} derived, ${reportValue.readiness.unscanned} unscanned ` +
      `(${reportValue.readiness.unscannedOfficial} official, ${reportValue.readiness.unscannedCommunity} community link-only)`,
    `Integration vocabulary: ${reportValue.integrationLabels.before.length} labels -> ${reportValue.integrationLabels.after.length} labels`,
    `Catalogue claims: ${reportValue.published} published, ${reportValue.quarantined} quarantined`,
    `Wrote ${reportValue.writtenArtifacts} artifacts, staged ${reportValue.stagedScannerSidecars} scanner sidecars`,
    `manifest sha256 ${reportValue.manifestSha256}`,
    `Unparseable upstream fixtures: ${unparseable.length}`,
    ...unparseable.map(
      (fixture) =>
        `  template ${fixture.templateId ?? 'n/a'} (${fixture.entryId}) ${fixture.slug}\n` +
        `    reason ${fixture.reason}; ${fixture.analysisStatus}/${fixture.grade}, ${fixture.findings} findings, ` +
        `${fixture.scannerVersion}/${fixture.profile}`,
    ),
    `Redistributable bodies: ${inventory.count} (${inventory.totalBytes} bytes, ${new Set(inventory.rows.map((row) => row.path)).size} pack file(s))`,
    `Redistribution claims: ${reportValue.redistributionEvidence.claims} checked, ` +
      `${reportValue.redistributionEvidence.evidenced} with recorded per-item licence evidence ` +
      `(journal: ${reportValue.redistributionEvidence.ledger ?? 'none supplied'})`,
  ].join('\n');
}

const started = performance.now();
const args = parseArguments(process.argv.slice(2));
const result = await runRegeneration({
  dataDir: path.resolve(args.data),
  outputDir: path.resolve(args.out),
  bodySources: args.bodySources.map((dir) => path.resolve(dir)),
  mapPath: path.resolve(args.map),
  generatedAt: args.generatedAt,
  legacyScannerStamps: args.legacyStamps,
  ...(args.rightsEvidence ? { rightsEvidencePath: path.resolve(args.rightsEvidence) } : {}),
});

const reportPath = path.resolve(args.report ?? path.join(args.out, '..', 'regeneration-report.json'));
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

// The inventory also lands on its own so a gate can hash and compare it without
// reading the whole report; the rows are already sorted by the builder.
const inventoryPath = path.join(path.dirname(reportPath), 'redistributable-body-inventory.json');
fs.writeFileSync(
  inventoryPath,
  `${JSON.stringify(
    {
      schemaVersion: 'redistributable-body-inventory-v1',
      generatedAt: result.generatedAt,
      count: result.redistributableBodies.count,
      totalBytes: result.redistributableBodies.totalBytes,
      rows: result.redistributableBodies.rows,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

process.stdout.write(`${report(result)}\n`);
process.stdout.write(`Report: ${reportPath}\n`);
process.stdout.write(`Redistributable body inventory: ${inventoryPath}\n`);
process.stdout.write(`Elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
process.stdout.write(`Promote with: node scripts/prepare-release-data.mjs ${args.out} --replace\n`);
