/**
 * The invariant the release is checked against, at the artifact level.
 *
 * 11,176 of 11,464 published entries are link-only — most because their
 * upstream repository carries no licence instrument at all. For those the
 * release carries derived facts and an upstream link; it does not serve the
 * file.
 *
 * `contracts/rights.ts` records the intent and `app/src/catalogue/download.ts`
 * gates the button. Neither looks at the packaged artifacts. This does: it
 * reads what is actually in `data/` and asks two questions.
 *
 *   1. Does a workflow body travel with an entry whose record does not carry
 *      `redistributable`?
 *   2. Does an entry that does carry `redistributable` have recorded per-item
 *      licence evidence behind the claim?
 *
 * Question 2 needs an input `data/` does not contain today: the rights-evidence
 * journal, one row per decision, carrying the basis the identifier was
 * established from. `evidenceRecords` is that journal, read by the caller; an
 * absent or silent journal is reported per row rather than treated as a pass,
 * because "no evidence recorded" and "evidence recorded and sufficient" are the
 * two states this check exists to keep apart.
 *
 * A failure here names entries and gaps. It is a statement about what the
 * artifacts record, not a legal conclusion, and it is not a build problem to be
 * worked around.
 */

/** Keys whose presence on an entry means a workflow body travelled with it. */
export const BODY_BEARING_KEYS = Object.freeze(['nodes', 'connections', 'workflow', 'download']);

const REDISTRIBUTABLE = 'redistributable';
const HASH = /^[0-9a-f]{64}$/;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Why the download a redistributable entry advertises cannot be served, or null.
 *
 * This is the per-entry half of the precondition, and it runs before the rights
 * gate can pass: `getDownloadSpec` (`app/src/catalogue/download.ts`) silently
 * returns null for the same inputs, so the only visible symptom of a broken
 * coordinate today is a control that renders and then fails. The checks mirror
 * its order so a failure names the branch instead of "invalid".
 *
 * `maxFallbackBytes` matters even though the bound itself lives in the reader:
 * a pack larger than the bound cannot be recovered when a host ignores Range,
 * so shipping one means shipping a download that can only work on a
 * well-behaved host.
 */
export function downloadSpecGap(entry, manifest, maxFallbackBytes) {
  const download = entry?.download;
  if (!download || typeof download !== 'object') {
    return 'without a download object';
  }
  if (typeof download.sha256 !== 'string' || !HASH.test(download.sha256)) {
    return 'without a 64-hex download.sha256 for the packed record';
  }
  if (!isCount(download.pack) || !isCount(download.line) || !isCount(download.offset) ||
    !Number.isSafeInteger(download.length) || download.length < 1) {
    return 'without safe-integer download coordinates and a length of at least 1';
  }
  const packPath = `packs/pack-${download.pack}.jsonl`;
  const artifact = (manifest?.artifacts ?? []).find((candidate) => candidate.path === packPath);
  if (!artifact) {
    return `whose ${packPath} is not declared in the release manifest`;
  }
  if (!isCount(artifact.byteSize)) {
    return `whose ${packPath} declares no usable byteSize`;
  }
  if (download.offset + download.length > artifact.byteSize) {
    return `whose range exceeds the pack: ${download.offset} + ${download.length} > byteSize ${artifact.byteSize}`;
  }
  const { offsets = [], lengths = [] } = artifact;
  if (!Array.isArray(offsets) || !Array.isArray(lengths) || offsets.length !== lengths.length) {
    return `whose ${packPath} declares no usable per-line offsets and lengths`;
  }
  if (download.line >= offsets.length) {
    return `whose line ${download.line} is beyond the ${offsets.length} lines ${packPath} declares`;
  }
  if (offsets[download.line] !== download.offset) {
    return `with a manifest offset mismatch: download.offset ${download.offset} but ${packPath} declares ${offsets[download.line]} at line ${download.line}`;
  }
  if (lengths[download.line] !== download.length) {
    return `with a manifest length mismatch: download.length ${download.length} but ${packPath} declares ${lengths[download.line]} at line ${download.line}`;
  }
  if (maxFallbackBytes !== undefined && artifact.byteSize > maxFallbackBytes) {
    return `whose pack exceeds the fallback bound: ${packPath} is ${artifact.byteSize} bytes, over ${maxFallbackBytes}`;
  }
  return null;
}

/** `LICENSE*` / `COPYING*` by basename; mirrors `isLicenceInstrument` in `pipeline/rights/evidence.ts`. */
function isLicenceInstrument(filename) {
  if (typeof filename !== 'string') return false;
  const base = filename.replace(/\\/g, '/').split('/').pop().toUpperCase();
  return base.startsWith('LICENSE') || base.startsWith('COPYING');
}

/**
 * Why one entry's recorded evidence does not support its redistribution claim,
 * or null when it does. Mirrors `redistributionEvidenceGap` in
 * `pipeline/rights/recorded-evidence.ts`; keep the two in step.
 */
export function redistributionEvidenceGap(id, record, journalPath) {
  if (record === undefined) {
    return journalPath === null
      ? 'no rights-evidence journal was supplied, so no per-item licence evidence is recorded for it'
      : `${journalPath} records no row for it`;
  }
  if (record.status !== REDISTRIBUTABLE) {
    return `the journal records status "${record.status}", not "${REDISTRIBUTABLE}"`;
  }
  const basis = record.evidence?.licenceBasis;
  if (basis !== 'same-commit-file') {
    return `the journal records licenceBasis "${basis ?? 'absent'}", not "same-commit-file"`;
  }
  const files = [
    ...(record.evidence?.rootLicence ?? []),
    ...(record.evidence?.siblingLicence ?? []),
    ...(record.evidence?.nestedLicence ?? []),
  ];
  const instruments = files.filter((file) => isLicenceInstrument(file?.filename) && typeof file?.sha256 === 'string' && file.sha256 !== '');
  if (instruments.length === 0) {
    return 'the journal names no same-commit licence instrument with a recorded digest';
  }
  return null;
}

/**
 * @param {{ entries: Array<Record<string, unknown>>, packWorkflowIds: string[],
 *   evidenceRecords?: Array<Record<string, unknown>>, journalPath?: string | null,
 *   manifest?: { artifacts?: Array<Record<string, unknown>> } | null,
 *   maxFallbackBytes?: number }} input
 *   `packWorkflowIds` are the entry ids whose bodies actually appear in
 *   `data/packs/*.jsonl` — the files a reader can download. `evidenceRecords`
 *   are the rights-evidence journal rows; `journalPath` names the journal in the
 *   diagnostics, and null means no journal was supplied. `manifest` is the
 *   parsed `data/manifest.json`, and `maxFallbackBytes` the reader's bound on the
 *   full-pack fallback; both are required for a redistributable entry's download
 *   to be judged servable at all.
 */
export function auditRightsInvariant({
  entries,
  packWorkflowIds,
  evidenceRecords = [],
  journalPath = null,
  manifest = null,
  maxFallbackBytes,
}) {
  const violations = [];
  const packed = new Set(packWorkflowIds);
  const journal = new Map();
  for (const record of evidenceRecords) {
    if (record && typeof record.id === 'string') journal.set(record.id, record);
  }
  let linkOnly = 0;
  let redistributable = 0;
  let unevidencedClaims = 0;

  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : '<no id>';
    const status = entry.rights?.status;

    if (status === undefined) {
      violations.push(`${id}: no rights record; an entry without a decision cannot be published`);
      continue;
    }

    // Anything that is not explicitly redistributable is treated as link-only.
    // A status nobody anticipated must not become a licence.
    if (status !== REDISTRIBUTABLE) {
      linkOnly += 1;
      for (const key of BODY_BEARING_KEYS) {
        if (entry[key] !== undefined) {
          violations.push(`${id}: rights status "${status}" but the entry carries \`${key}\``);
        }
      }
      if (packed.has(id)) {
        violations.push(`${id}: rights status "${status}" but a packed workflow body ships for it`);
      }
      continue;
    }

    redistributable += 1;
    if (!packed.has(id)) {
      violations.push(`${id}: redistributable with no packed body; the download would serve nothing`);
    }
    // Before the evidence question: a claim about a file the reader cannot
    // address is not a rights question, it is a broken download.
    const download = downloadSpecGap(entry, manifest, maxFallbackBytes);
    if (download !== null) {
      violations.push(`${id}: redistributable entry ${download}`);
    }
    const gap = redistributionEvidenceGap(id, journal.get(id), journalPath);
    if (gap !== null) {
      unevidencedClaims += 1;
      violations.push(`${id}: redistributable with no recorded per-item licence evidence — ${gap}`);
    }
  }

  for (const id of packed) {
    if (!entries.some((entry) => entry.id === id)) {
      violations.push(`${id}: a packed workflow body ships for an entry not in the catalogue`);
    }
  }

  return { violations, linkOnly, redistributable, unevidencedClaims };
}
