import type { Entry } from '@hub/contracts';
import type { Manifest } from './manifest';
import { loadManifest } from './manifest';
import { attributionFilename, buildAttribution } from './download-attribution';
import { verifyRangeResponse, verifySlicedResponse } from './download-verify';
import { verifyContentHash } from './download-content-hash';
import { MAX_FALLBACK_PACK_BYTES } from './download-limits.mjs';
import { sitePath } from '../ui/site-url.mjs';
export type DownloadProgressCallback = (progressRatio: number) => void;
export type DownloadSpec = {
  packPath: string;
  line: number;
  offset: number;
  length: number;
  /** Full byte size of the pack artifact, needed to validate a `Content-Range` response header. */
  totalSize: number;
  /** AUDIT-DL-001: the packed record's own hash, when the release publishes one. */
  sha256?: string;
};
function isSafeCoordinate(value: unknown, minimum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum; }
/** Hash the exact UTF-8 `JSON.stringify(workflow)` bytes, excluding only its one JSONL LF. */
async function verifyPackedRecord(bytes: Uint8Array, expected: string | undefined): Promise<void> {
  // Never serve a record whose bytes were not checked: an absent digest is a
  // release defect, not legacy metadata. `getDownloadSpec` rejects it earlier;
  // this keeps a hand-built spec from skipping verification silently.
  if (!expected) throw new Error('Packed workflow record has no published digest to verify against.');
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error('Packed workflow record is missing its JSONL newline.');
  await verifyContentHash(new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, -1)), expected);
}
function selectFallbackRecord(packBytes: Uint8Array, spec: DownloadSpec): Uint8Array {
  if (packBytes.byteLength !== spec.totalSize) {
    throw new Error(`Full pack is ${packBytes.byteLength} bytes; expected exactly ${spec.totalSize}.`);
  }
  const end = spec.offset + spec.length;
  if (end > packBytes.byteLength) {
    throw new Error(`Workflow record ${spec.line} exceeds the full pack boundary.`);
  }
  if ((spec.offset > 0 && packBytes[spec.offset - 1] !== 0x0a) || packBytes[end - 1] !== 0x0a) {
    throw new Error(`Workflow record ${spec.line} is not bounded by canonical JSONL newlines.`);
  }
  return packBytes.slice(spec.offset, end);
}
/** Extract and cross-check pack metadata against the release manifest. */
export function getDownloadSpec(entry: Entry, manifest?: Manifest): DownloadSpec | null {
  if (entry.rights?.status !== 'redistributable') {
    return null;
  }

  const download = entry.download;
  if (
    !download ||
    typeof download.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(download.sha256) ||
    !isSafeCoordinate(download.pack, 0) ||
    !isSafeCoordinate(download.line, 0) ||
    !isSafeCoordinate(download.offset, 0) ||
    !isSafeCoordinate(download.length, 1)
  ) {
    return null;
  }

  const packPath = `packs/pack-${download.pack}.jsonl`;
  const artifacts = manifest?.artifacts;
  const artifact = Array.isArray(artifacts)
    ? artifacts.find((candidate) => candidate.path === packPath)
    : undefined;
  const offsets = artifact?.offsets;
  const lengths = artifact?.lengths;
  if (
    !artifact || artifact.encoding !== undefined && artifact.encoding !== 'identity' ||
    !Array.isArray(offsets) || !Array.isArray(lengths) || offsets.length !== lengths.length ||
    download.line >= offsets.length ||
    !isSafeCoordinate(artifact.byteSize, 0) ||
    download.offset > artifact.byteSize ||
    download.length > artifact.byteSize - download.offset ||
    offsets[download.line] !== download.offset ||
    lengths[download.line] !== download.length
  ) {
    return null;
  }

  return { packPath, line: download.line, offset: download.offset, length: download.length, totalSize: artifact.byteSize, sha256: download.sha256 };
}

/** Fetch raw workflow JSON for a downloadable entry. */
export async function fetchWorkflowJson(
  entry: Entry,
  manifest?: Manifest,
  onProgress?: DownloadProgressCallback,
): Promise<{ jsonText: string; filename: string }> {
  if (entry.rights?.status !== 'redistributable') {
    throw new Error('Link-only entry cannot be downloaded directly.');
  }

  const spec = getDownloadSpec(entry, manifest);
  if (!spec) {
    throw new Error('No verified download specification available for entry.');
  }

  onProgress?.(0.1);
  const url = sitePath(`/data/${spec.packPath}`);
  const filename = `${entry.slug}.json`;

  const ranged = await tryRangeDownload(url, spec, entry, onProgress);
  if (ranged !== null) {
    onProgress?.(1.0);
    return { jsonText: ranged, filename };
  }

  // Revalidate a full-pack fallback after any failed range verification.
  // The bound sits here, not at the top: a verified 206 for a larger pack is a
  // legitimate ranged download, and only the whole-pack fallback is refused.
  if (spec.totalSize > MAX_FALLBACK_PACK_BYTES) {
    throw new Error('Full-pack fallback exceeds the bounded pack size.');
  }
  onProgress?.(0.3);
  const fullRes = await fetch(url);
  if (!fullRes.ok) {
    throw new Error(`Failed to fetch pack ${spec.packPath}: ${fullRes.status}`);
  }
  const declaredHeader = fullRes.headers.get('content-length');
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared !== spec.totalSize) {
    throw new Error('Pack Content-Length mismatch.');
  }

  onProgress?.(0.7);
  const fullBytes = new Uint8Array(await fullRes.arrayBuffer());
  const targetBytes = selectFallbackRecord(fullBytes, spec);
  const jsonText = verifySlicedResponse(targetBytes, spec, entry);
  await verifyPackedRecord(targetBytes, spec.sha256);

  onProgress?.(1.0);
  return { jsonText, filename };
}

/** Attempt a verified range request; null means the caller must revalidate a full pack. */
async function tryRangeDownload(
  url: string,
  spec: DownloadSpec,
  entry: Entry,
  onProgress?: DownloadProgressCallback,
): Promise<string | null> {
  try {
    const rangeHeader = `bytes=${spec.offset}-${spec.offset + spec.length - 1}`;
    const res = await fetch(url, { headers: { Range: rangeHeader } });
    if (res.status !== 206 && res.status !== 200) return null;
    if (res.status === 200) {
      // The host ignored Range. Never read the whole pack body here: the caller
      // decides, against the fallback bound, whether a full pack is acceptable.
      await res.body?.cancel();
      return null;
    }

    onProgress?.(0.8);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const jsonText = verifyRangeResponse(bytes, spec, entry, res.headers.get('content-range'));
    await verifyPackedRecord(bytes, spec.sha256);
    return jsonText;
  } catch {
    return null;
  }
}

function save(blobUrl: string, filename: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

export type WorkflowDownload = {
  blobUrl: string;
  filename: string;
  jsonText: string;
  attribution: { blobUrl: string; filename: string; text: string };
};

/** Download a workflow and its separate licence notice. */
export async function downloadWorkflow(
  entry: Entry,
  manifest?: Manifest,
  onProgress?: DownloadProgressCallback,
): Promise<WorkflowDownload> {
  if (entry.rights?.status !== 'redistributable') {
    throw new Error('Link-only entry cannot be downloaded directly.');
  }
  const m = manifest || (await loadManifest());
  const { jsonText, filename } = await fetchWorkflowJson(entry, m, onProgress);

  const blobUrl = URL.createObjectURL(new Blob([jsonText], { type: 'application/json' }));
  const text = buildAttribution(entry);
  const noticeUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const noticeName = attributionFilename(entry);

  save(blobUrl, filename);
  save(noticeUrl, noticeName);

  return { blobUrl, filename, jsonText, attribution: { blobUrl: noticeUrl, filename: noticeName, text } };
}
