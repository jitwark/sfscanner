import { readdirSync } from 'node:fs';
import path from 'node:path';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { readOfficialBodyVerdict } from './admissible-body.js';
import { readOfficialCatalogueSide } from './official-catalogue.js';

/**
 * The join between the published catalogue's official entries and the authentic
 * workflow bodies retained outside the repository. Both sides are keyed by one
 * integer — `source.templateId` and `official__<templateId>_<slug>.json` — so the
 * join is a set intersection rather than a similarity guess, and it can be proved
 * to reconcile instead of asserted.
 *
 * Bodies live in more than one local folder and not every one is usable:
 * `01_deduplicated_master/` holds legacy copies carrying injected `_security` and
 * `_documentation` blocks. Sources are declared in order — the first source
 * holding a template supplies it — and each supplying body is checked by
 * `admissible-body.ts`. A refused body is reported with its offending keys and the
 * entry stays unscanned: never stripped, never silently skipped.
 */
export type BodySource = {
  /** Machine-local folder holding body files. Never a repo path, never committed. */
  dir: string;
  /** Where this folder came from, declared by the operator. Acquired, never inferred. */
  provenance: string;
};

export type OfficialBodyRow = {
  templateId: number;
  entryId: string;
  /** File name only. The directory is a machine-local input, never a repo path. */
  file: string;
  sourceDir: string;
  provenance: string;
};

/** A body that exists on disk and may not be used, with the keys that disqualified it. */
export type RefusedBody = {
  templateId: number;
  file: string;
  sourceDir: string;
  provenance: string;
  offendingKeys: string[];
};

export type OfficialBodyMap = {
  /** Entries that have an admissible body, ascending by templateId. */
  rows: OfficialBodyRow[];
  /** Official entries with no usable body: legacy metadata, or a body the guard refused. */
  withoutBody: Array<{ templateId: number; entryId: string }>;
  /** Bodies that were found and refused, ascending by templateId. */
  refusedBodies: RefusedBody[];
  /** Bodies whose templateId no catalogue entry claims. */
  orphanBodies: Array<{ templateId: number; file: string; sourceDir: string; provenance: string }>;
  counts: {
    catalogueOfficial: number;
    /** Files matching the body naming convention across every source, duplicates included. */
    bodyFiles: number;
    /** Directory entries that are not bodies at all: a source folder is heterogeneous. */
    ignoredBodyFiles: number;
    matched: number;
    withoutBody: number;
    /** Bodies refused by the guard (each named in `refusedBodies`), and files an earlier slot owns. */
    refused: number;
    shadowedBodyFiles: number;
    orphanBodyFiles: number;
    /** Entries sharing a templateId: non-zero makes the join ambiguous and the caller must refuse. */
    duplicateCatalogueTemplateIds: number;
    duplicateBodyTemplateIds: number;
    /** Official entries carrying no integer `source.templateId`. */
    entriesWithoutTemplateId: number;
    /** Files starting with `official` that do not fit the naming convention. */
    malformedBodyFileNames: number;
  };
};

const BODY_FILE_NAME = /^official__(\d+)_(.+)\.json$/;
/**
 * A near-miss body name is a finding; a `github_*` neighbour and a provenance
 * sidecar are simply not bodies. Only a `.json` name can be a near-miss: the
 * convention is a `.json` file, and a `.jsonl` receipt the acquisition writes
 * into the same folder is inventory, not a body that lost its template id.
 */
const OFFICIAL_JSON_NAME = /^official.*\.json$/i;

export function parseOfficialBodyFileName(name: string): { templateId: number; slug: string } | null {
  const match = BODY_FILE_NAME.exec(name);
  if (!match) return null;
  const templateId = Number(match[1]);
  return Number.isSafeInteger(templateId) ? { templateId, slug: match[2] } : null;
}

export type OfficialBodyFileListing = {
  /** templateId -> the canonically-first file holding it in this directory. */
  byTemplate: Map<number, string>;
  matchingFiles: number;
  duplicates: number;
  ignoredFiles: number;
  malformedNames: number;
};

/**
 * List one directory's bodies. Which duplicate wins must not depend on a host
 * directory listing's order, so names are sorted canonically first.
 */
export function listOfficialBodyFiles(dir: string): OfficialBodyFileListing {
  const byTemplate = new Map<number, string>();
  let matchingFiles = 0;
  let duplicates = 0;
  let ignoredFiles = 0;
  let malformedNames = 0;
  for (const name of [...readdirSync(dir)].sort(compareCanonicalStrings)) {
    const parsed = parseOfficialBodyFileName(name);
    if (!parsed) {
      if (OFFICIAL_JSON_NAME.test(name)) malformedNames += 1;
      else ignoredFiles += 1;
      continue;
    }
    matchingFiles += 1;
    if (byTemplate.has(parsed.templateId)) duplicates += 1;
    else byTemplate.set(parsed.templateId, name);
  }
  return { byTemplate, matchingFiles, duplicates, ignoredFiles, malformedNames };
}

/** Ascending numeric order. `Array#sort` defaults to string order, which would put 10000 before 999. */
function ascending(a: number, b: number): number {
  return a - b;
}

export function buildOfficialBodyMap(
  catalogueShards: readonly (readonly unknown[])[],
  bodySources: readonly BodySource[],
): OfficialBodyMap {
  const catalogue = readOfficialCatalogueSide(catalogueShards);
  const rows: OfficialBodyRow[] = [];
  const refusedBodies: RefusedBody[] = [];
  const orphanBodies: OfficialBodyMap['orphanBodies'] = [];
  const owned = new Set<number>();
  let bodyFiles = 0;
  let ignoredBodyFiles = 0;
  let duplicates = 0;
  let shadowedBodyFiles = 0;
  let malformedBodyFileNames = 0;

  for (const [index, source] of bodySources.entries()) {
    if (typeof source?.provenance !== 'string' || source.provenance.trim().length === 0) {
      throw new Error(`body source ${index} declares no provenance: provenance is acquired, never inferred`);
    }
    const listing = listOfficialBodyFiles(source.dir);
    bodyFiles += listing.matchingFiles;
    ignoredBodyFiles += listing.ignoredFiles;
    duplicates += listing.duplicates;
    malformedBodyFileNames += listing.malformedNames;

    for (const templateId of [...listing.byTemplate.keys()].sort(ascending)) {
      const file = listing.byTemplate.get(templateId) as string;
      // First source wins, and a refusal is final: no later source is consulted
      // for a template an earlier one already owns, so a refusal cannot be undone.
      if (owned.has(templateId)) {
        shadowedBodyFiles += 1;
        continue;
      }
      owned.add(templateId);
      const ref = { templateId, file, sourceDir: source.dir, provenance: source.provenance };
      const entryId = catalogue.byTemplate.get(templateId);
      if (entryId === undefined) {
        orphanBodies.push(ref);
        continue;
      }
      const verdict = readOfficialBodyVerdict(path.join(source.dir, file));
      if (verdict.kind === 'authentic') rows.push({ ...ref, entryId });
      else refusedBodies.push({ ...ref, offendingKeys: verdict.offendingKeys });
    }
  }

  const matched = new Set(rows.map((row) => row.templateId));
  const withoutBody = [...catalogue.byTemplate]
    .filter(([templateId]) => !matched.has(templateId))
    .map(([templateId, entryId]) => ({ templateId, entryId }))
    .sort((a, b) => ascending(a.templateId, b.templateId));
  rows.sort((a, b) => ascending(a.templateId, b.templateId));
  refusedBodies.sort((a, b) => ascending(a.templateId, b.templateId));
  orphanBodies.sort((a, b) => ascending(a.templateId, b.templateId));

  return {
    rows,
    withoutBody,
    refusedBodies,
    orphanBodies,
    counts: {
      catalogueOfficial: catalogue.total,
      bodyFiles,
      ignoredBodyFiles,
      matched: rows.length,
      withoutBody: withoutBody.length,
      refused: refusedBodies.length,
      shadowedBodyFiles,
      orphanBodyFiles: orphanBodies.length,
      duplicateCatalogueTemplateIds: catalogue.duplicates,
      duplicateBodyTemplateIds: duplicates,
      entriesWithoutTemplateId: catalogue.missingTemplateId,
      malformedBodyFileNames,
    },
  };
}

/**
 * The accounting the map must satisfy before anything downstream trusts it:
 * every official entry either has a body or does not, and every body file is
 * matched, refused, shadowed, an orphan, or a directory duplicate.
 */
export function officialBodyMapReconciles(map: OfficialBodyMap): string[] {
  const failures: string[] = [];
  const { counts } = map;
  if (counts.matched + counts.withoutBody !== counts.catalogueOfficial) {
    failures.push(`matched ${counts.matched} + withoutBody ${counts.withoutBody} != catalogue official ${counts.catalogueOfficial}`);
  }
  const accounted = counts.matched + counts.refused + counts.shadowedBodyFiles + counts.orphanBodyFiles + counts.duplicateBodyTemplateIds;
  if (accounted !== counts.bodyFiles) {
    failures.push(
      `matched ${counts.matched} + refused ${counts.refused} + shadowed ${counts.shadowedBodyFiles} + orphan ${counts.orphanBodyFiles} + duplicate ${counts.duplicateBodyTemplateIds} != body files ${counts.bodyFiles}`,
    );
  }
  if (counts.duplicateCatalogueTemplateIds !== 0) {
    failures.push(`${counts.duplicateCatalogueTemplateIds} duplicate templateId(s) on the catalogue side`);
  }
  if (counts.duplicateBodyTemplateIds !== 0) {
    failures.push(`${counts.duplicateBodyTemplateIds} duplicate templateId(s) on the body side`);
  }
  if (counts.entriesWithoutTemplateId !== 0) {
    failures.push(`${counts.entriesWithoutTemplateId} official entr(y|ies) carry no integer source.templateId`);
  }
  if (counts.malformedBodyFileNames !== 0) {
    failures.push(`${counts.malformedBodyFileNames} file(s) start with "official" but do not match the official__<templateId>_<slug>.json convention`);
  }
  return failures;
}

/** The map in the canonical serialized form, so two runs can be compared byte for byte. */
export function serializeOfficialBodyMap(map: OfficialBodyMap): string {
  return `${JSON.stringify({ schemaVersion: 'official-body-map-v1', ...map }, null, 2)}\n`;
}
