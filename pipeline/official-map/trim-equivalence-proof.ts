import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { isWorkflowBody, stripAnnotations } from './admissible-body.js';
import { canonicalJson, firstDifferingPaths, parseBodyBytes } from './body-content-diff.js';
import { listOfficialBodyFiles } from './body-map.js';

/**
 * Whether the master folder's annotated bodies may be trimmed into usable ones.
 *
 * The master copies are not usable as they stand: they carry two blocks curation
 * removed (`_security`, `_documentation`), and the guard in `admissible-body.ts`
 * refuses them. Refusing costs the 449 unscanned entries whose only body is a
 * master copy, so the owner permitted **trimming instead of refusal, but only
 * behind an equivalence proof measured over the bodies both folders hold**: for
 * every template id in the curated folder *and* the master folder, the master
 * body with its annotations removed must equal the curated body. One content
 * mismatch disables trimming entirely and the master folder reverts to refusal.
 *
 * Two comparisons are measured and reported **separately, because they are
 * different claims**: canonical equality (parsed JSON with keys sorted, compared
 * as canonical serialisations) says the content is the same; raw-byte equality
 * says the two files are the same bytes, which also requires the same key order
 * and the same formatting. Where bytes differ but canonical JSON matches, the
 * content is identical and only the presentation differs — that is *not*
 * byte-for-byte identity and is never reported as such. The gate keys on content
 * mismatches, and `formatOnlyMatches` is carried in the artifact so the two
 * counts cannot be read as one another.
 *
 * See `docs/audit/2026-09-28-body-coverage/trim-equivalence.json` for the run.
 */
export type TrimEquivalenceEvidence = {
  schemaVersion: string;
  /** The folder the pipeline already binds, and the reference for the comparison. */
  curatedDir: string;
  /** The annotated folder under test. */
  masterDir: string;
  /** Template ids present in both folders. Ids in only one folder prove nothing and are not compared. */
  pairsCompared: number;
  /** Pairs equal as canonical JSON with the annotations removed. */
  canonicalMatches: number;
  /** Pairs equal byte for byte, the trimmed master against the curated file. */
  rawByteMatches: number;
  /** Canonical JSON equal but bytes not: the same content in another key order or formatting. */
  formatOnlyMatches: number;
  /** Pairs whose content differs beyond the annotations. Any entry here disables trimming. */
  contentMismatchIds: number[];
  /** The first few mismatches with the first few differing JSON paths, so the difference is namable. */
  sampleMismatches: Array<{ templateId: number; file: string; differingPaths: string[] }>;
  /** Which annotation keys were removed, and from how many compared bodies. */
  removedKeyHistogram: Array<{ key: string; count: number }>;
  /** How many of each folder's own files this module's encoder reproduces exactly. */
  encoderFidelity: { curatedRoundTrips: number; masterRoundTrips: number };
};

/** The artifact as committed: the measurements above, plus the gate's verdict on them. */
export type TrimEquivalenceProof = TrimEquivalenceEvidence & {
  verdict: 'trim-permitted' | 'trim-refused';
  verdictReason: string;
};

export type TrimVerdict = { permitted: boolean; reason: string };

export const TRIM_EQUIVALENCE_SCHEMA = 'official-body-trim-equivalence-v1';

const MISMATCH_SAMPLE_LIMIT = 5;
const DIFFERING_PATH_LIMIT = 3;

/**
 * The corpus's own body-file encoding, measured rather than assumed: two-space
 * indent, CRLF line endings, and curated files closed with a trailing CRLF. The
 * evidence's `encoderFidelity` records how many of each folder's files this
 * reproduces exactly, so the raw-byte comparison cannot be mistaken for a
 * convenient re-encoding invented here: the encoder is the folders' own format,
 * applied to a body whose annotations are gone.
 */
export function encodeCorpusBodyFile(body: unknown, trailingNewline: boolean): Buffer {
  return Buffer.from(`${JSON.stringify(body, null, 2).replace(/\n/g, '\r\n')}${trailingNewline ? '\r\n' : ''}`, 'utf8');
}

export function measureTrimEquivalence(options: {
  curatedDir: string;
  masterDir: string;
}): TrimEquivalenceProof {
  const curatedDir = path.resolve(options.curatedDir);
  const masterDir = path.resolve(options.masterDir);
  const curated = listOfficialBodyFiles(curatedDir);
  const master = listOfficialBodyFiles(masterDir);
  const pairs = [...curated.byTemplate.keys()].filter((templateId) => master.byTemplate.has(templateId)).sort((a, b) => a - b);

  const contentMismatchIds: number[] = [];
  const sampleMismatches: TrimEquivalenceEvidence['sampleMismatches'] = [];
  const removedKeys = new Map<string, number>();
  let canonicalMatches = 0;
  let rawByteMatches = 0;
  let formatOnlyMatches = 0;
  let curatedRoundTrips = 0;
  let masterRoundTrips = 0;

  for (const templateId of pairs) {
    const curatedFile = curated.byTemplate.get(templateId) as string;
    const masterFile = master.byTemplate.get(templateId) as string;
    const curatedBytes = readFileSync(path.join(curatedDir, curatedFile));
    const masterBytes = readFileSync(path.join(masterDir, masterFile));
    const curatedBody = parseBodyBytes(curatedBytes);
    const masterBody = parseBodyBytes(masterBytes);

    const stripped = isWorkflowBody(masterBody) ? stripAnnotations(masterBody) : undefined;
    for (const key of stripped?.removedKeys ?? []) removedKeys.set(key, (removedKeys.get(key) ?? 0) + 1);
    const trimmed = stripped === undefined ? masterBody : stripped.body;

    if (encodeCorpusBodyFile(curatedBody, true).equals(curatedBytes)) curatedRoundTrips += 1;
    if (encodeCorpusBodyFile(masterBody, false).equals(masterBytes)) masterRoundTrips += 1;

    if (canonicalJson(trimmed) !== canonicalJson(curatedBody)) {
      contentMismatchIds.push(templateId);
      if (sampleMismatches.length < MISMATCH_SAMPLE_LIMIT) {
        sampleMismatches.push({
          templateId,
          file: masterFile,
          differingPaths: firstDifferingPaths(trimmed, curatedBody, DIFFERING_PATH_LIMIT),
        });
      }
      continue;
    }
    canonicalMatches += 1;
    if (encodeCorpusBodyFile(trimmed, true).equals(curatedBytes)) rawByteMatches += 1;
    else formatOnlyMatches += 1;
  }

  const evidence: TrimEquivalenceEvidence = {
    schemaVersion: TRIM_EQUIVALENCE_SCHEMA,
    curatedDir,
    masterDir,
    pairsCompared: pairs.length,
    canonicalMatches,
    rawByteMatches,
    formatOnlyMatches,
    contentMismatchIds,
    sampleMismatches,
    removedKeyHistogram: [...removedKeys]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => compareCanonicalStrings(a.key, b.key)),
    encoderFidelity: { curatedRoundTrips, masterRoundTrips },
  };
  const verdict = assessTrimProof(evidence, [masterDir]);
  return {
    ...evidence,
    verdict: verdict.permitted ? 'trim-permitted' : 'trim-refused',
    verdictReason: verdict.reason,
  };
}

/**
 * The gate. It reads the *evidence* and recomputes: a recorded `verdict` field on
 * a committed artifact is documentation, and cannot switch trimming on, because
 * this function never looks at one. Trimming needs a proof that compared at least
 * one pair, reconciled its own counts, was measured against a folder the caller
 * is actually reading, and found no content mismatch at all.
 */
export function assessTrimProof(proof: TrimEquivalenceEvidence, bodyDirs: readonly string[]): TrimVerdict {
  if (proof.schemaVersion !== TRIM_EQUIVALENCE_SCHEMA) {
    return { permitted: false, reason: `proof schema ${String(proof.schemaVersion)} is not ${TRIM_EQUIVALENCE_SCHEMA}` };
  }
  const failures = trimEquivalenceReconciles(proof);
  if (failures.length > 0) {
    return { permitted: false, reason: `the proof does not reconcile: ${failures.join('; ')}` };
  }
  if (proof.pairsCompared === 0) {
    return { permitted: false, reason: 'the proof compared no pairs, so it is evidence of nothing' };
  }
  if (!bodyDirs.some((dir) => path.resolve(dir) === path.resolve(proof.masterDir))) {
    return { permitted: false, reason: `the proof is about ${proof.masterDir}, which is not one of the folders being read` };
  }
  if (proof.contentMismatchIds.length > 0) {
    return {
      permitted: false,
      reason: `${proof.contentMismatchIds.length} of ${proof.pairsCompared} compared pairs differ in content beyond their annotations`,
    };
  }
  return {
    permitted: true,
    reason: `${proof.pairsCompared} compared pairs are content-identical once their annotations are removed`,
  };
}

/**
 * The arithmetic the evidence has to satisfy before it may be handed to the gate:
 * every compared pair is either a canonical match or a content mismatch, and the
 * byte count is a subset of the canonical one — bytes cannot match where content
 * does not.
 */
export function trimEquivalenceReconciles(proof: TrimEquivalenceEvidence): string[] {
  const failures: string[] = [];
  if (proof.canonicalMatches + proof.contentMismatchIds.length !== proof.pairsCompared) {
    failures.push(
      `canonicalMatches ${proof.canonicalMatches} + contentMismatchIds ${proof.contentMismatchIds.length} != pairsCompared ${proof.pairsCompared}`,
    );
  }
  if (proof.rawByteMatches + proof.formatOnlyMatches !== proof.canonicalMatches) {
    failures.push(
      `rawByteMatches ${proof.rawByteMatches} + formatOnlyMatches ${proof.formatOnlyMatches} != canonicalMatches ${proof.canonicalMatches}`,
    );
  }
  if (proof.rawByteMatches > proof.canonicalMatches) {
    failures.push(`rawByteMatches ${proof.rawByteMatches} > canonicalMatches ${proof.canonicalMatches}`);
  }
  if (!proof.contentMismatchIds.every((id, index, ids) => index === 0 || ids[index - 1] < id)) {
    failures.push('contentMismatchIds is not ascending and unique');
  }
  const fidelity = proof.encoderFidelity;
  if (fidelity.curatedRoundTrips > proof.pairsCompared || fidelity.masterRoundTrips > proof.pairsCompared) {
    failures.push('encoderFidelity counts more files than were compared');
  }
  return failures;
}

/** The artifact in the canonical serialized form, so two runs compare byte for byte. */
export function serializeTrimEquivalenceProof(proof: TrimEquivalenceProof): string {
  // Stamped after the spread so the artifact always carries this module's schema,
  // and the key order is unchanged: overriding a key keeps its position.
  return `${JSON.stringify({ ...proof, schemaVersion: TRIM_EQUIVALENCE_SCHEMA }, null, 2)}\n`;
}
