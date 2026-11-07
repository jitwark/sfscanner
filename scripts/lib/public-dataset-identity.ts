import { relationNames, relationRows, type ExportProjection, type ExportRelease } from '../../pipeline/export/export-version.js';
/**
 * The public dataset's own release id, derived from the dataset rather than
 * from the clock.
 *
 * The id used to be `release-<corpus generation date>`, so two different byte
 * states generated from the same corpus generation shared one name — and a
 * rollback, a cache or a verification step keyed on that name could act on the
 * wrong bytes while believing it had the right ones. `outputs/public-dataset`
 * showed it: its manifest and its `.previous` generation both declared
 * `release-2026-09-04` while their SQLite and Excel bytes differed.
 *
 * `sealIdentity` and `releaseIdFrom` (`./release-identity.mjs`) are the
 * mechanism the outer staged release record already uses: an id is
 * `release-<day>-<first 12 hex of a digest over the sealed identity and its
 * section hashes>`. This module points that one mechanism at the dataset
 * bundle instead of inventing a second scheme, so the dataset's id and the
 * staged release's id are the same kind of claim.
 *
 * The sealed identity is the dataset's declared metadata — schema, tool,
 * scanner, policy, search-index and build-revision identities, corpus and
 * manifest hashes, relation counts and rights facets — and the sections are
 * every relation whose rows do not name the release itself, digested over the
 * exact bytes `ndjson/<relation>.ndjson` ships (`canonicalRowBytes` is the one
 * serialization both the writer and this file use). `releases` and `artifacts`
 * are excluded because a digest cannot contain the id it derives; everything
 * else they carry is the sealed identity or a hash of bytes another section
 * already covers.
 *
 * Two consequences make the id usable, and both are exercised by
 * `public-dataset-identity.test.ts`: content or identity that differs cannot
 * produce the same id, and a bundle's id can be re-derived from the bundle
 * alone (`verifyDatasetReleaseId`) with no corpus, clock or build to consult.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  type PublicRelationNameV4,
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1,
  PUBLIC_RELATION_NAMES,
  type PublicRelationName,
} from '../../contracts/public-data-model.js';
import { canonicalRowBytes, RELEASE_ID_RELATIONS } from '../../pipeline/export/ndjson.js';
import { releaseIdFrom, sealIdentity } from './release-identity.mjs';

export const DATASET_IDENTITY_SCHEMA = 'public-dataset-identity-v1';

/** The sections a bundle can ship without naming its own id — see the file header. */
export const DATASET_CONTENT_RELATIONS: readonly PublicRelationName[] = Object.freeze(
  PUBLIC_RELATION_NAMES.filter((relation) => !RELEASE_ID_RELATIONS.includes(relation)),
);

const HASH = /^[a-f0-9]{64}$/u;
const COUNT_FIELDS = ['workflows', 'redistributable', 'linkOnly', 'excluded', 'findings'] as const;
const RIGHTS_FIELDS = ['redistributable', 'linkOnly', 'excluded'] as const;
const TEXT_FIELDS = ['schemaVersion', 'generatedAt', 'toolVersion', 'scannerVersion', 'policyVersion', 'searchIndexVersion', 'buildRevision', 'releaseId'] as const;

export type DatasetIdentityCheck = {
  releaseId: string;
  derived: string;
  matches: boolean;
  sections: Readonly<Record<string, string>>;
};

/**
 * A bundle that cannot answer "are these the bytes this id names?" for a reason
 * the caller can act on. `LEGACY_V1` is not a malformed bundle: v1 rows carry
 * no `scanEvidence`, so the current pipeline has to re-export them; `verifyDatasetReleaseId`
 * cannot derive an id from them and must say so instead of implying corruption.
 */
export class DatasetIdentityError extends Error {
  constructor(message: string, readonly code: 'LEGACY_V1' | 'INVALID_BUNDLE') {
    super(message);
    this.name = 'DatasetIdentityError';
  }
}

/**
 * The dataset's declared identity: its release metadata without the id, which
 * metadata cannot contain. Key order is written out here rather than inherited
 * from the caller's object, because the sealed digest is a `JSON.stringify` of
 * this exact shape and `verifyDatasetReleaseId` rebuilds it from the shipped
 * shard — a verifier must be able to reproduce it field for field. The nested
 * `corpus.generatedAt` is where `releaseIdFrom` reads the day from.
 */
export function datasetIdentity(metadata: ExportRelease): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: DATASET_IDENTITY_SCHEMA,
    releaseSchemaVersion: metadata.schemaVersion,
    tool: Object.freeze({ version: metadata.toolVersion }),
    scanner: Object.freeze({ version: metadata.scannerVersion }),
    policy: Object.freeze({ version: metadata.policyVersion }),
    searchIndex: Object.freeze({ version: metadata.searchIndexVersion }),
    build: Object.freeze({ revision: metadata.buildRevision }),
    corpus: Object.freeze({
      generatedAt: metadata.generatedAt,
      corpusSha256: metadata.corpusSha256,
      manifestSha256: metadata.manifestSha256,
    }),
    counts: Object.freeze({
      workflows: metadata.counts.workflows,
      redistributable: metadata.counts.redistributable,
      linkOnly: metadata.counts.linkOnly,
      excluded: metadata.counts.excluded,
      findings: metadata.counts.findings,
    }),
    facets: Object.freeze({
      rights: Object.freeze({
        redistributable: metadata.facetCounts.rights.redistributable,
        linkOnly: metadata.facetCounts.rights.linkOnly,
        excluded: metadata.facetCounts.rights.excluded,
      }),
    }),
  });
}

function* canonicalRowStream(relation: PublicRelationNameV4, rows: readonly unknown[]): Generator<Buffer> {
  for (const row of rows) yield canonicalRowBytes(relation, row);
}

/** One digest per content relation, over whatever bytes the caller has: rows before a write, shard files after one. */
function sectionDigests(bytesFor: (relation: PublicRelationNameV4) => Iterable<Uint8Array>, relations: readonly PublicRelationNameV4[] = DATASET_CONTENT_RELATIONS): Readonly<Record<string, string>> {
  const sections: Record<string, string> = {};
  for (const relation of relations) {
    const hasher = crypto.createHash('sha256');
    for (const bytes of bytesFor(relation)) hasher.update(bytes);
    sections[relation] = hasher.digest('hex');
  }
  return Object.freeze(sections);
}

/** The content sections of a projection that has not been written yet. */
export function projectionSections(projection: ExportProjection): Readonly<Record<string, string>> {
  return sectionDigests((relation) => canonicalRowStream(relation, relationRows(projection, relation)), relationNames(projection).filter((relation) => !(RELEASE_ID_RELATIONS as readonly string[]).includes(relation)));
}

/** The dataset's id: the outer release scheme, sealed over this dataset's identity and content. */
export function sealedDatasetId(metadata: ExportRelease, sections: Readonly<Record<string, string>>): string {
  return releaseIdFrom(sealIdentity(datasetIdentity(metadata), sections));
}

function shardPath(bundleDir: string, relation: PublicRelationNameV4): string {
  return path.join(bundleDir, 'ndjson', `${relation}.ndjson`);
}

function readShard(bundleDir: string, relation: PublicRelationName): unknown[] {
  const contents = fs.readFileSync(shardPath(bundleDir, relation), 'utf8');
  if (contents.length === 0) return [];
  if (!contents.endsWith('\n')) throw new Error(`dataset identity: the ${relation} shard does not end with a newline`);
  return contents.slice(0, -1).split('\n').map((line) => JSON.parse(line) as unknown);
}

/**
 * The `releases` row a bundle ships, read back as the release metadata it is.
 * A bundle carries its own identity inputs, which is what lets a consumer
 * re-derive the id without the corpus, clock or build that produced it.
 */
export function readBundleMetadata(bundleDir: string): ExportRelease {
  const rows = readShard(bundleDir, 'releases');
  const row = rows.length === 1 && typeof rows[0] === 'object' && rows[0] !== null ? (rows[0] as Record<string, unknown>) : {};
  if (row.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V1) {
    throw new DatasetIdentityError(
      'dataset identity: public-data-model-v1 has no content-derived identity; re-export with the current pipeline and promote the v2 bundle',
      'LEGACY_V1',
    );
  }
  const counts = typeof row.counts === 'object' && row.counts !== null ? (row.counts as Record<string, unknown>) : undefined;
  const facets = typeof row.facetCounts === 'object' && row.facetCounts !== null ? (row.facetCounts as { rights?: unknown }) : undefined;
  const rights = typeof facets?.rights === 'object' && facets.rights !== null ? (facets.rights as Record<string, unknown>) : undefined;
  const complete = (row.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION || row.schemaVersion === PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4) &&
    TEXT_FIELDS.every((field) => typeof row[field] === 'string' && row[field] !== '') &&
    [row.manifestSha256, row.corpusSha256].every((value) => typeof value === 'string' && HASH.test(value)) &&
    counts !== undefined && COUNT_FIELDS.every((field) => Number.isSafeInteger(counts[field])) &&
    rights !== undefined && RIGHTS_FIELDS.every((field) => Number.isSafeInteger(rights[field]));
  if (!complete) {
    throw new DatasetIdentityError(
      `dataset identity: ${shardPath(bundleDir, 'releases')} does not ship one valid release metadata row`,
      'INVALID_BUNDLE',
    );
  }
  return row as unknown as ExportRelease;
}

/**
 * Re-derives a shipped bundle's id from the bundle alone: its own metadata row
 * and the content shards it ships. This is the consumer's answer to "are these
 * the bytes this id names?", and it is why the id needs no external authority
 * to be checkable.
 */
export function verifyDatasetReleaseId(bundleDir: string): DatasetIdentityCheck {
  const metadata = readBundleMetadata(bundleDir);
  const sections = sectionDigests((relation) => [fs.readFileSync(shardPath(bundleDir, relation))], relationNames(metadata).filter((relation) => !(RELEASE_ID_RELATIONS as readonly string[]).includes(relation)));
  const derived = sealedDatasetId(metadata, sections);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'public-release.json'), 'utf8')) as { releaseId?: unknown };
  if (typeof manifest.releaseId !== 'string' || manifest.releaseId === '') {
    throw new DatasetIdentityError(`dataset identity: ${path.join(bundleDir, 'public-release.json')} declares no release id`, 'INVALID_BUNDLE');
  }
  if (metadata.releaseId !== manifest.releaseId) {
    throw new DatasetIdentityError(
      `dataset identity: the releases row declares ${metadata.releaseId} but public-release.json declares ${manifest.releaseId}`,
      'INVALID_BUNDLE',
    );
  }
  return { releaseId: manifest.releaseId, derived, matches: manifest.releaseId === derived, sections };
}
