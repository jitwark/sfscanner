import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import receiptDocument from '../../../../docs/scanner/semantic-source-receipts.json';
import { SemanticCatalogueAdmissionError } from './catalogue-admission';
import type { SemanticProvenanceV2 } from './catalogue-schema';

/**
 * Built-in semantic catalogue provenance binding (packet B1b, subpacket 1).
 *
 * Before this module, every record's `provenance.sourceDigest` was one of two repeated
 * placeholder strings. The digest is now *derived* from
 * `docs/scanner/semantic-source-receipts.json` (packet B1a), so a changed upstream byte or a
 * changed supporting-file list changes that record's digest, and with it the catalogue digest.
 *
 * Frozen binding rule, pinned by `builtin-catalogue.test.ts`:
 *
 *   - `sourceUrl` stays the human-facing n8n documentation page for the node family
 *     (`CORE_DOCS`/`LANGCHAIN_DOCS` in the catalogue). This is a deliberate split between the
 *     *documentation* URL and the *provenance* digest: the admission contract requires an https
 *     URL without credentials, and the receipt's tarball URL is not a page a reader can use.
 *   - `sourceDigest` is the canonical digest over the record's supporting files: take the
 *     record's `documentsRecords` entries (`<package>@<version>:<path>`), sort them as strings,
 *     emit `<entry>:<sha256>` per entry, join with `\n` and no trailing newline, and hash the
 *     UTF-8 bytes. Sorting makes the digest order-insensitive; every entry and every digest
 *     inside it changes the result.
 *   - `reviewedAt` is the `fetchedAt` of the receipt packages the record's files come from (all
 *     of them must agree), and `reviewer` is `REVIEW_IDENTITY` — an explicit *agent*-review
 *     label. The B1a receipt records an AI review worker, so no human sign-off is claimed.
 *
 * Fail closed: a record with no `documentsRecords` entry, an empty entry, an entry whose file is
 * absent from the receipt packages, a non-string entry, a package entry missing fields, or a
 * malformed digest throws `SemanticCatalogueAdmissionError('INVALID_PROVENANCE')` — the typed
 * error the catalogue admission path already raises for invalid input. There is no silent
 * fallback to a placeholder.
 *
 * The receipt is a static JSON import rather than a `loadSemanticSourceReceipts(...)` call:
 * this module is reachable from the browser worker bundle (`app/src/scanner/scan.worker.ts` ->
 * `@hub/scanner-core/v2` -> `builtin-catalogue.ts`), and `packages/scanner-core/src` is a
 * browser-safe tree that must not import node builtins (`pipeline/check-browser-safe.mjs`).
 * `scripts/lib/semantic-source-receipts.mjs` remains the shape authority for the receipt file;
 * this module revalidates the subset of it that the binding depends on.
 */
export type SourceReceiptFile = { readonly path: string; readonly sha256: string };
export type SourceReceiptPackage = {
  readonly package: string;
  readonly version: string;
  readonly fetchedAt: string;
  readonly files: readonly SourceReceiptFile[];
};
export type SourceReceipts = {
  readonly packages: readonly SourceReceiptPackage[];
  readonly documentsRecords?: Readonly<Record<string, readonly string[]>>;
};
export type SourceProvenanceBinding = (semanticId: string, sourceUrl: string) => SemanticProvenanceV2;

const DIGEST = /^[0-9a-f]{64}$/;
const REVIEW_IDENTITY = 'scanner-core-semantics-agent-review';

function fail(label: string, reason: string): never {
  throw new SemanticCatalogueAdmissionError('INVALID_PROVENANCE', `${label}: ${reason}`);
}

function receiptIndex(receipts: SourceReceipts): Map<string, { sha256: string; fetchedAt: string }> {
  const index = new Map<string, { sha256: string; fetchedAt: string }>();
  for (const entry of receipts?.packages ?? []) {
    const usable = typeof entry?.package === 'string' && typeof entry.version === 'string' && typeof entry.fetchedAt === 'string';
    if (!usable || !Array.isArray(entry.files) || entry.files.length === 0) fail('receipt', 'a package entry is missing package, version, fetchedAt or files');
    for (const file of entry.files) {
      if (typeof file?.path !== 'string' || typeof file.sha256 !== 'string') fail('receipt', 'a package file entry is missing path or sha256');
      index.set(`${entry.package}@${entry.version}:${file.path}`, { sha256: file.sha256, fetchedAt: entry.fetchedAt });
    }
  }
  return index;
}

export function createSourceProvenanceBinding(receipts: SourceReceipts): SourceProvenanceBinding {
  const index = receiptIndex(receipts);
  return (semanticId, sourceUrl) => {
    const refs = receipts?.documentsRecords?.[semanticId];
    if (refs === undefined) fail(semanticId, 'the receipt documents no supporting files for this record');
    if (!Array.isArray(refs) || refs.length === 0) fail(semanticId, 'the documentsRecords entry lists no supporting files');
    const files = [...refs].sort().map((ref) => {
      if (typeof ref !== 'string') fail(semanticId, 'a documentsRecords entry is not a string');
      const file = index.get(ref);
      if (file === undefined) fail(semanticId, `${ref} is absent from the receipt packages`);
      if (!DIGEST.test(file.sha256)) fail(semanticId, `${ref} carries a malformed digest`);
      return { ref, sha256: file.sha256, fetchedAt: file.fetchedAt };
    });
    if (new Set(files.map((file) => file.fetchedAt)).size !== 1) fail(semanticId, 'supporting files were fetched on different dates');
    const lines = files.map((file) => `${file.ref}:${file.sha256}`);
    return Object.freeze({
      sourceUrl,
      sourceDigest: bytesToHex(sha256(new TextEncoder().encode(lines.join('\n')))),
      reviewedAt: files[0].fetchedAt,
      reviewer: REVIEW_IDENTITY,
    });
  };
}

/** Provenance for the built-in catalogue, bound to the committed receipt. */
export const builtinSourceProvenance: SourceProvenanceBinding = createSourceProvenanceBinding(receiptDocument as SourceReceipts);
