/**
 * The evidence a rights decision is made on, and the arithmetic that turns a
 * candidate's recorded source facts into it.
 *
 * Two distinctions this module exists to keep, because collapsing either one is
 * how a redistribution claim gets made without its support:
 *
 * 1. **Established vs. recorded.** A licence blob's SHA-256 recorded at the
 *    selected commit is not the same fact as an SPDX id in a REST response.
 *    `licenceBasis` names which one we have: `same-commit-file` when a licence
 *    or notice instrument was recorded at the commit the workflow came from,
 *    `metadata-only` when the identifier only ever came from repository
 *    metadata, `none` when neither. A metadata-only response is not same-commit
 *    proof and cannot carry a redistribution claim.
 *
 * 2. **Root vs. sibling vs. nested.** The root instrument is the file the
 *    basis is taken from; a licence file in a subdirectory holds different
 *    bytes, so what it grants is not what the root instrument grants and the
 *    two are reported separately rather than merged. Blobs are compared by
 *    SHA-256, never by parsing licence prose: this module records what bytes a
 *    commit held, and reading a licence into an identifier would be an
 *    interpretation rather than a record.
 */

/** A licence or notice blob recorded at the selected commit. */
export type LicenceEvidenceFile = { filename: string; sha256: string };

/**
 * Where the licence identifier came from. `same-commit-file` is the basis that
 * names a recorded licence instrument; `metadata-only` names an identifier that
 * only ever arrived as a field in a repository metadata response.
 */
export type LicenceBasis = 'same-commit-file' | 'metadata-only' | 'none';

/** The configured `expectedLicence` for the source, against the acquired id. */
export type ExpectedLicenceMatch = 'match' | 'mismatch' | 'no-expectation';

/** What acquisition recorded about one workflow, before any rule reads it. */
export type RightsEvidenceInput = {
  /** The selected source commit — the commit the body hash belongs to. */
  sourceCommit: string | null;
  /** SHA-1 git blob id of the committed workflow bytes, or a recorded digest. */
  bodyHash: string | null;
  rootLicence: LicenceEvidenceFile[];
  nestedLicence: LicenceEvidenceFile[];
  siblingLicence: LicenceEvidenceFile[];
  licenceBasis: LicenceBasis;
};

/** The evidence a decision was made on, plus the comparison it performed. */
export type RightsEvidence = RightsEvidenceInput & {
  workflowPath: string;
  expectedLicence: string | null;
  expectedLicenceMatch: ExpectedLicenceMatch;
};

/**
 * Fills an absent evidence record with what is actually known: nothing.
 *
 * The defaults are deliberately the ones that withhold redistribution —
 * `licenceBasis: 'metadata-only'`, no recorded licence files. A caller that
 * forgot to supply evidence must not thereby acquire permission.
 */
export function completeEvidence(partial?: Partial<RightsEvidenceInput>): RightsEvidenceInput {
  return {
    sourceCommit: partial?.sourceCommit ?? null,
    bodyHash: partial?.bodyHash ?? null,
    rootLicence: partial?.rootLicence ?? [],
    nestedLicence: partial?.nestedLicence ?? [],
    siblingLicence: partial?.siblingLicence ?? [],
    licenceBasis: partial?.licenceBasis ?? 'metadata-only',
  };
}

/** Compares the acquired identifier with the configured expectation. */
export function expectedLicenceMatch(
  observed: string | null,
  expected: string | null | undefined,
): ExpectedLicenceMatch {
  if (expected === null || expected === undefined) return 'no-expectation';
  return observed === expected ? 'match' : 'mismatch';
}

/** Directory part of a repository-relative path; `''` for a root file. */
export function dirOf(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

/**
 * Sorts every recorded licence blob into the three places it can be relative to
 * one workflow: the repository root, the workflow's own directory (its
 * siblings), and everywhere else below the root (nested).
 *
 * Root files are never counted as siblings of a root workflow, so the three
 * lists stay disjoint and `root + sibling + nested` is every recorded blob.
 */
export function splitLicenceFiles(
  workflowPath: string,
  files: readonly LicenceEvidenceFile[],
): Pick<RightsEvidenceInput, 'rootLicence' | 'siblingLicence' | 'nestedLicence'> {
  const rootLicence: LicenceEvidenceFile[] = [];
  const siblingLicence: LicenceEvidenceFile[] = [];
  const nestedLicence: LicenceEvidenceFile[] = [];
  const workflowDir = dirOf(workflowPath);

  for (const file of files) {
    const fileDir = dirOf(file.filename);
    if (fileDir === '') rootLicence.push(file);
    else if (workflowDir !== '' && fileDir === workflowDir) siblingLicence.push(file);
    else nestedLicence.push(file);
  }

  return { rootLicence, siblingLicence, nestedLicence };
}

/**
 * A licence file in a strict ancestor directory of the workflow, below the root.
 * Such a file governs the subtree the workflow sits in, without being its
 * sibling when the workflow is deeper than one directory.
 */
export function ancestorLicenceFiles(
  workflowPath: string,
  files: readonly LicenceEvidenceFile[],
): LicenceEvidenceFile[] {
  const workflowDir = dirOf(workflowPath);
  if (workflowDir === '') return [];
  return files.filter((file) => {
    const fileDir = dirOf(file.filename);
    return fileDir !== '' && fileDir !== workflowDir && `${workflowDir}/`.startsWith(`${fileDir}/`);
  });
}

/** Licence files that apply to a workflow and do not restate the root licence. */
export type ContraryLicenceGroups = {
  /** Different terms sitting in the workflow's own directory. */
  sibling: LicenceEvidenceFile[];
  /** Different terms sitting in a directory the workflow is nested under. */
  ancestor: LicenceEvidenceFile[];
};

/**
 * Licence blobs that apply to this workflow and hold different bytes than the
 * repository's own root licence instrument.
 *
 * Compared by SHA-256, not by parsing: a byte-different licence file is a fact,
 * while a differing SPDX id would be our reading of someone else's prose. A
 * subtree file whose bytes match the root instrument is the same terms restated
 * and is not a conflict.
 */
export function contraryLicenceGroups(
  workflowPath: string,
  files: readonly LicenceEvidenceFile[],
  rootLicence: readonly LicenceEvidenceFile[],
): ContraryLicenceGroups {
  const rootHashes = new Set(rootLicence.map((file) => file.sha256));
  const workflowDir = dirOf(workflowPath);

  return {
    sibling: files
      .filter((file) => workflowDir !== '' && dirOf(file.filename) === workflowDir)
      .filter((file) => !rootHashes.has(file.sha256)),
    ancestor: ancestorLicenceFiles(workflowPath, files).filter(
      (file) => !rootHashes.has(file.sha256),
    ),
  };
}

/**
 * Whether a recorded blob is a licence instrument this module takes a basis
 * from: a `LICENSE*` or `COPYING*` file, by basename, matching what
 * `collectLicenceEvidence` records.
 *
 * `NOTICE` is deliberately not one. A notice file is attribution — a repository
 * can carry one, and a component inside it can carry one, with no grant in it —
 * so a root `NOTICE` on its own does not establish that a licence instrument
 * was recorded at the commit. It stays in the evidence lists, where the
 * contrary-evidence comparison reads it, but it cannot be the basis.
 */
export function isLicenceInstrument(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toUpperCase();
  return base.startsWith('LICENSE') || base.startsWith('COPYING');
}

/**
 * How the identifier was established, from what acquisition actually recorded.
 * A root licence instrument means a licence instrument was recorded at the
 * selected commit; otherwise only metadata carried the identifier, or nothing
 * did.
 */
export function deriveLicenceBasis(input: {
  apiLicencePresent: boolean;
  licenceFiles: readonly LicenceEvidenceFile[];
}): LicenceBasis {
  if (input.licenceFiles.some((file) => dirOf(file.filename) === '' && isLicenceInstrument(file.filename))) {
    return 'same-commit-file';
  }
  return input.apiLicencePresent ? 'metadata-only' : 'none';
}
