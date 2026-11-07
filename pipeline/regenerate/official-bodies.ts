import fs from 'node:fs';
import path from 'node:path';
import {
  officialBodyMapReconciles,
  type OfficialBodyMap,
} from '../official-map/body-map.js';

/**
 * Read side of the official-body map, for the regeneration run.
 *
 * The map is the emitter's own artifact, so it is re-verified here against the
 * same equations the emitter refuses on rather than trusted because it exists.
 * A map that silently mis-joined would attribute one template's verdicts to
 * another template's entry, which is the one failure the ledger cannot detect
 * downstream: every entry would still have exactly one body.
 *
 * `declaredSources` are the folders this invocation was told to bind. They must
 * be the folders the map actually bound, or the run refuses: a declaration the
 * map never used is a source nothing read, and a map folder nobody declared is
 * a corpus the run was not told about.
 */
export function loadOfficialBodyMap(mapPath: string, declaredSources: readonly string[]): OfficialBodyMap {
  if (!fs.existsSync(mapPath)) {
    throw new Error(
      `No official-body map at ${mapPath}. Emit it first: ` +
      'npx tsx pipeline/official-map/emit-body-map.ts --bodies "<dir>"',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as OfficialBodyMap;
  if (!Array.isArray(parsed?.rows) || !Array.isArray(parsed?.withoutBody) || typeof parsed?.counts !== 'object') {
    throw new Error(`Official-body map at ${mapPath} is not an official-body-map artifact`);
  }
  const failures = officialBodyMapReconciles(parsed);
  if (failures.length > 0) {
    throw new Error(`Official-body map does not reconcile:\n  ${failures.join('\n  ')}`);
  }
  const mismatch = sourceMismatch(parsed, declaredSources);
  if (mismatch !== null) throw new Error(mismatch);
  return parsed;
}

/**
 * Where one matched body lives: the file name plus the source folder the map
 * recorded for it. Bodies come from more than one folder, so the read path
 * resolves each row's own folder instead of one directory for the whole run.
 */
export type OfficialBodyRef = { file: string; sourceDir: string };

/** Entry id -> the body file and the source folder the map recorded for it. */
export function bodyFileByEntryId(map: OfficialBodyMap): Map<string, OfficialBodyRef> {
  const byEntryId = new Map<string, OfficialBodyRef>();
  for (const row of map.rows) byEntryId.set(row.entryId, { file: row.file, sourceDir: row.sourceDir });
  return byEntryId;
}

/** The machine-local folders the map bound something from, resolved and deduplicated. */
export function mapSourceDirs(map: OfficialBodyMap): string[] {
  const dirs = new Set<string>();
  for (const ref of [...map.rows, ...map.refusedBodies, ...map.orphanBodies]) dirs.add(path.resolve(ref.sourceDir));
  return [...dirs].sort();
}

/**
 * The invocation has to declare exactly the folders the map bound. A `--bodies`
 * the map never used would tell an operator they bound a corpus nothing read;
 * a map folder the invocation does not declare would mean reading a folder the
 * run was never told about. Both are refusals, not warnings, because a silently
 * dropped source is indistinguishable from a source with no bodies in it.
 */
export function sourceMismatch(map: OfficialBodyMap, declared: readonly string[]): string | null {
  const recorded = mapSourceDirs(map);
  const given = [...new Set(declared.map((dir) => path.resolve(dir)))].sort();
  const same = recorded.length === given.length && recorded.every((dir, index) => dir === given[index]);
  if (same) return null;
  return (
    `The map bound bodies from ${recorded.join(', ') || '(no folder)'}, ` +
    `but this run declared ${given.join(', ') || '(no folder)'}`
  );
}

/**
 * Parse one retained body.
 *
 * The official corpus is genuinely unsanitized and the file names are the only
 * provenance, so nothing here is logged beyond the file name on failure — an
 * error message must not carry a body, because a body is where the secrets are.
 */
export function readOfficialBody(bodiesDir: string, fileName: string): unknown {
  const absolute = path.join(bodiesDir, fileName);
  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    throw new Error(`Official body could not be read: ${fileName}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Official body is not valid JSON: ${fileName}`);
  }
}
