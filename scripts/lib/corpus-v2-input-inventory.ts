/**
 * Classification of the bodies bound to corpus entries — packet C1 of
 * `docs/superpowers/plans/2026-10-17-completion-data-exports.md`, as amended by
 * `docs/audit/2026-10-17-remediation/C1-INTERFACE-AMENDMENT.md`, the authority for
 * the exact receipt union (including its `identityKind | null`, `counts` and
 * `ownerRuledUnavailable` errata).
 *
 * Pure: no filesystem access, no acquisition, no body text retained; bytes come
 * only from the injected `readBytes`, called with each binding's resolved
 * absolute path after containment and identity have been checked, so a body the
 * caller does not authorize can never enter a receipt. Symlinks are invisible
 * here (that would need `fs`); the injected reader owns realpath policy. Admission
 * is parseable JSON, not scanner admission: fatal UTF-8 `TextDecoder` + `JSON.parse`,
 * so a body valid as JSON but violating a scanner limit is `AVAILABLE` here and
 * rejected by `scanWorkflowV2` in the pipeline.
 *
 * Statuses, in check order:
 * - no source row → `MISSING` (`NO_SOURCE_BINDING`);
 * - `ownerRuledUnavailable` present → `SOURCE_UNAVAILABLE` (reason = the ruling,
 *   or `OWNER_RULED_UNAVAILABLE`), checked first and never read — an owner ruling
 *   wins over any body that appears;
 * - `localPath` not inside `approvedRoot` after both are resolved → `REJECTED`
 *   (`PATH_OUTSIDE_APPROVED_ROOT`); the root itself is not inside, `..` segments
 *   resolving back inside are fine, sibling prefixes are not;
 * - identity not internally consistent → `REJECTED` (`SOURCE_IDENTITY_MISMATCH`):
 *   `GITHUB` needs non-blank repo/commit/path; `OFFICIAL_TEMPLATE` a positive
 *   integer `templateId` and a `file` equal to the binding's basename; a
 *   caller-supplied `expectedIdentity` must match field for field. Never read;
 * - missing bytes → `MISSING` (`BODY_NOT_FOUND`) even when an expectation exists;
 *   an expectation names an authorized body, not its presence;
 * - empty → `EMPTY_BODY`; an invalid UTF-8 sequence → `INVALID_UTF8_BODY`; bytes
 *   `JSON.parse` rejects, or that parse to anything but an object/array →
 *   `UNPARSEABLE_BODY` (all `UNPARSEABLE`);
 * - digest differing from a retained `expectedSha256` → `REJECTED`
 *   (`DIGEST_MISMATCH`): the body exists and is not the authorized one — a
 *   rejection, not an absence; `null` means no expectation was retained and the
 *   digest is still recorded;
 * - otherwise `AVAILABLE`.
 * `bodySha256`/`byteLength` are recorded whenever bytes were read; `sourceCommit`/
 * `sourcePath` mirror a `GITHUB` identity verbatim and stay null for
 * `OFFICIAL_TEMPLATE`. Two source rows binding one entry id throw
 * `DuplicateCorpusV2InputBindingError` — no first/last winner; duplicate ids in
 * `entries` collapse to one receipt. Receipts sort by `entryId` byte-wise (not
 * locale-aware). `inventorySha256` is the SHA-256 of the UTF-8
 * `JSON.stringify({ schemaVersion, counts, rows })`, excluding itself; hashing
 * uses `node:crypto` `createHash('sha256')` lowercase hex, matching `scripts/lib`.
 */
import crypto from 'node:crypto';
import path from 'node:path';

export type CorpusV2InputReceiptStatus = 'AVAILABLE' | 'MISSING' | 'SOURCE_UNAVAILABLE' | 'UNPARSEABLE' | 'REJECTED';

export type CorpusV2InputIdentity =
  | Readonly<{ kind: 'GITHUB'; sourceRepo: string; sourceCommit: string; sourcePath: string }>
  | Readonly<{ kind: 'OFFICIAL_TEMPLATE'; templateId: number; sourceDir: string; file: string }>;

export type CorpusV2InputSource = Readonly<{
  entryId: string;
  localPath: string;
  approvedRoot: string;
  approvalRecord: string;
  identity: CorpusV2InputIdentity;
  /**
   * Optional caller-captured identity (e.g. the catalogue's `source` block).
   * When present, the declared identity must match it field for field (exact
   * strings, including `sourceDir`) or the row is rejected unread. Absent means
   * the check is unavailable, not that it passed.
   */
  expectedIdentity?: CorpusV2InputIdentity;
  expectedSha256: string | null;
  rightsEvidenceRef: string;
  /** Caller-recorded owner ruling (e.g. `RULING-1`) forbidding acquisition; its presence marks the row `SOURCE_UNAVAILABLE`. Never inferred. */
  ownerRuledUnavailable?: string;
}>;

export type CorpusV2InputReceipt = Readonly<{
  entryId: string;
  /** Null exactly when no source row of any kind bound the entry. */
  identityKind: 'GITHUB' | 'OFFICIAL_TEMPLATE' | null;
  status: CorpusV2InputReceiptStatus;
  bodySha256: string | null;
  byteLength: number | null;
  sourceCommit: string | null;
  sourcePath: string | null;
  reasonCode: string | null;
}>;

export type CorpusV2InputInventory = Readonly<{
  schemaVersion: 'corpus-v2-input-inventory-v1';
  counts: Readonly<Record<CorpusV2InputReceiptStatus, number>>;
  rows: readonly CorpusV2InputReceipt[];
  inventorySha256: string;
}>;

/** Two source rows for one entry id: an ambiguity the inventory refuses to resolve. */
export class DuplicateCorpusV2InputBindingError extends Error {
  constructor(entryId: string) {
    super(`corpus v2 input inventory: entry "${entryId}" is bound by more than one source row`);
    this.name = 'DuplicateCorpusV2InputBindingError';
  }
}

const SCHEMA_VERSION = 'corpus-v2-input-inventory-v1';

/** One decoder for the whole run; a rejected byte sequence throws and is never decoded leniently. */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const isNonEmpty = (value: string): boolean => value.trim().length > 0;

/** Containment on already-resolved paths; a result of `..` or an absolute result is outside. */
const isInsideApprovedRoot = (localAbs: string, rootAbs: string): boolean => {
  const relative = path.relative(rootAbs, localAbs);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Null when the identity is internally consistent; otherwise the rejection reason. */
const identityProblem = (identity: CorpusV2InputIdentity, localAbs: string): string | null => {
  switch (identity.kind) {
    case 'GITHUB':
      return isNonEmpty(identity.sourceRepo) && isNonEmpty(identity.sourceCommit) && isNonEmpty(identity.sourcePath)
        ? null
        : 'SOURCE_IDENTITY_MISMATCH';
    case 'OFFICIAL_TEMPLATE':
      return Number.isInteger(identity.templateId) && identity.templateId > 0 && path.basename(localAbs) === identity.file
        ? null
        : 'SOURCE_IDENTITY_MISMATCH';
    default:
      return 'SOURCE_IDENTITY_MISMATCH';
  }
};

/** Field-for-field comparison for a caller-supplied `expectedIdentity`. */
const sameIdentity = (declared: CorpusV2InputIdentity, expected: CorpusV2InputIdentity): boolean => {
  if (declared.kind === 'GITHUB' && expected.kind === 'GITHUB') return declared.sourceRepo === expected.sourceRepo && declared.sourceCommit === expected.sourceCommit && declared.sourcePath === expected.sourcePath;
  if (declared.kind === 'OFFICIAL_TEMPLATE' && expected.kind === 'OFFICIAL_TEMPLATE') return declared.templateId === expected.templateId && declared.sourceDir === expected.sourceDir && declared.file === expected.file;
  return false;
};

type Classification = Pick<CorpusV2InputReceipt, 'status' | 'bodySha256' | 'byteLength' | 'reasonCode'>;

const classify = (source: CorpusV2InputSource, readBytes: (localPath: string) => Uint8Array | undefined): Classification => {
  const ruling = source.ownerRuledUnavailable;
  if (ruling !== undefined) {
    return { status: 'SOURCE_UNAVAILABLE', bodySha256: null, byteLength: null, reasonCode: isNonEmpty(ruling) ? ruling : 'OWNER_RULED_UNAVAILABLE' };
  }

  const localAbs = path.resolve(source.localPath);
  const notRead = { bodySha256: null, byteLength: null } as const;

  if (!isInsideApprovedRoot(localAbs, path.resolve(source.approvedRoot))) {
    return { ...notRead, status: 'REJECTED', reasonCode: 'PATH_OUTSIDE_APPROVED_ROOT' };
  }
  if (identityProblem(source.identity, localAbs) !== null) {
    return { ...notRead, status: 'REJECTED', reasonCode: 'SOURCE_IDENTITY_MISMATCH' };
  }
  if (source.expectedIdentity !== undefined && !sameIdentity(source.identity, source.expectedIdentity)) {
    return { ...notRead, status: 'REJECTED', reasonCode: 'SOURCE_IDENTITY_MISMATCH' };
  }

  const bytes = readBytes(localAbs);
  if (bytes === undefined) {
    return { ...notRead, status: 'MISSING', reasonCode: 'BODY_NOT_FOUND' };
  }

  const evidence = { bodySha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  if (bytes.length === 0) return { ...evidence, status: 'UNPARSEABLE', reasonCode: 'EMPTY_BODY' };

  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return { ...evidence, status: 'UNPARSEABLE', reasonCode: 'INVALID_UTF8_BODY' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...evidence, status: 'UNPARSEABLE', reasonCode: 'UNPARSEABLE_BODY' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...evidence, status: 'UNPARSEABLE', reasonCode: 'UNPARSEABLE_BODY' };
  }
  if (source.expectedSha256 !== null && source.expectedSha256 !== evidence.bodySha256) {
    return { ...evidence, status: 'REJECTED', reasonCode: 'DIGEST_MISMATCH' };
  }
  return { ...evidence, status: 'AVAILABLE', reasonCode: null };
};

const receiptFor = (
  entryId: string,
  source: CorpusV2InputSource | undefined,
  readBytes: (localPath: string) => Uint8Array | undefined,
): CorpusV2InputReceipt => {
  const identity = source?.identity;
  const github = identity !== undefined && identity.kind === 'GITHUB' ? identity : undefined;
  const classification =
    source === undefined
      ? { status: 'MISSING' as const, bodySha256: null, byteLength: null, reasonCode: 'NO_SOURCE_BINDING' }
      : classify(source, readBytes);

  return {
    entryId,
    identityKind: identity?.kind ?? null,
    status: classification.status,
    bodySha256: classification.bodySha256,
    byteLength: classification.byteLength,
    sourceCommit: github?.sourceCommit ?? null,
    sourcePath: github?.sourcePath ?? null,
    reasonCode: classification.reasonCode,
  };
};

export function inventoryCorpusV2Inputs(
  entries: readonly { readonly id: string }[],
  sources: readonly CorpusV2InputSource[],
  readBytes: (localPath: string) => Uint8Array | undefined,
): CorpusV2InputInventory {
  const byEntryId = new Map<string, CorpusV2InputSource>();
  for (const source of sources) {
    if (byEntryId.has(source.entryId)) throw new DuplicateCorpusV2InputBindingError(source.entryId);
    byEntryId.set(source.entryId, source);
  }

  // Every entry gets a receipt, and so does every source binding — an unbound entry is MISSING, an unbound-by-entries source is not silently dropped.
  const rows = [...new Set([...entries.map((entry) => entry.id), ...byEntryId.keys()])]
    .map((entryId) => receiptFor(entryId, byEntryId.get(entryId), readBytes))
    .sort((left, right) => Buffer.compare(Buffer.from(left.entryId), Buffer.from(right.entryId)));

  // Keys are written out in this order so the canonical hash is stable.
  const counts: Record<CorpusV2InputReceiptStatus, number> = {
    AVAILABLE: 0,
    MISSING: 0,
    SOURCE_UNAVAILABLE: 0,
    UNPARSEABLE: 0,
    REJECTED: 0,
  };
  for (const row of rows) counts[row.status] += 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    counts,
    rows,
    inventorySha256: crypto
      .createHash('sha256')
      .update(JSON.stringify({ schemaVersion: SCHEMA_VERSION, counts, rows }), 'utf8')
      .digest('hex'),
  };
}
