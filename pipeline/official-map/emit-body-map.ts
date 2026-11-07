import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildOfficialBodyMap,
  type BodySource,
  officialBodyMapReconciles,
  serializeOfficialBodyMap,
} from './body-map.js';
import { readCatalogueShards } from './official-catalogue.js';

/**
 * Emit the official-body map for the phase that re-derives published readiness
 * and verdicts from the authentic bodies.
 *
 *   npx tsx pipeline/official-map/emit-body-map.ts --bodies "<dir>=<provenance>" [--bodies …] [--data data] [--out <file>]
 *
 * `--bodies` names a directory outside the repository together with the
 * provenance the operator declares for it. It may be repeated, and the first
 * source holding a template supplies it. A source without provenance is refused
 * rather than given a default: provenance is acquired, never inferred. These
 * bodies are not redistributable and are never committed; nothing here writes
 * under `data/`, because the map is an input to a regeneration, not an artifact.
 */
type Args = { sources: BodySource[]; dataDir: string; out: string };

function parseBodySource(value: string): BodySource {
  const at = value.lastIndexOf('=');
  const dir = at > 0 ? value.slice(0, at) : '';
  const provenance = at > 0 ? value.slice(at + 1) : '';
  if (dir.length === 0 || provenance.length === 0 || /\s/.test(provenance)) {
    throw new Error(`--bodies needs <dir>=<provenance>, got "${value}": provenance is acquired, never inferred`);
  }
  return { dir: path.resolve(dir), provenance };
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const sources: BodySource[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    if (key === '--bodies') sources.push(parseBodySource(value));
    else values.set(key.slice(2), value);
    index += 1;
  }
  if (sources.length === 0) {
    throw new Error('--bodies <dir>=<provenance> is required at least once: the map cannot guess where the bodies live');
  }
  return {
    sources,
    dataDir: path.resolve(values.get('data') ?? 'data'),
    out: path.resolve(values.get('out') ?? path.join('pipeline', '.work', 'official-body-map.json')),
  };
}

function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const map = buildOfficialBodyMap(readCatalogueShards(args.dataDir), args.sources);
  writeFileSync(args.out, serializeOfficialBodyMap(map));
  process.stdout.write(
    `${JSON.stringify(
      {
        out: args.out,
        sources: args.sources,
        counts: map.counts,
        // The refused bodies themselves are in the artifact; the first few are
        // echoed here so a refused source is visible in the run's own output.
        refusedBodies: map.refusedBodies.slice(0, 10),
      },
      null,
      2,
    )}\n`,
  );

  const failures = officialBodyMapReconciles(map);
  for (const failure of failures) process.stderr.write(`reconciliation failed: ${failure}\n`);
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('emit-body-map.ts') || process.argv[1]?.endsWith('emit-body-map.js')) {
  process.exitCode = run(process.argv.slice(2));
}
