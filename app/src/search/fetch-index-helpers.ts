import type { Manifest } from '../catalogue/manifest';

export type ProgressCallback = (loadedBytes: number, totalBytes: number) => void;

export type SearchIndexFailureKind = 'unavailable' | 'http' | 'malformed' | 'schema' | 'stale-release';

export type SearchReleaseIdentity = {
  schemaVersion: string;
  generatedAt: string;
  searchIndexSha256: string;
};

export type VerifiedSearchIndex = {
  indexJson: string;
  identity: SearchReleaseIdentity;
};

export type OptionalSearchPayloadFailureReason = SearchIndexFailureKind | 'absent';
export type OptionalSearchPayloadResult =
  | { ok: true; json: string }
  | { ok: false; reason: OptionalSearchPayloadFailureReason; retryable: boolean };

export class SearchIndexError extends Error {
  readonly kind: SearchIndexFailureKind;
  readonly releaseIdentity?: SearchReleaseIdentity;

  constructor(kind: SearchIndexFailureKind, message: string, options?: ErrorOptions, releaseIdentity?: SearchReleaseIdentity) {
    super(message, options);
    this.name = 'SearchIndexError';
    this.kind = kind;
    this.releaseIdentity = releaseIdentity;
  }
}

export function searchReleaseIdentityFromManifest(manifest: Manifest): SearchReleaseIdentity {
  const artifact = manifest.artifacts.find((candidate) => candidate.path === 'search-index.json');
  if (!artifact) throw new SearchIndexError('schema', 'Release manifest has no search index artifact');
  return { schemaVersion: manifest.schemaVersion, generatedAt: manifest.generatedAt, searchIndexSha256: artifact.sha256 };
}

export function formatSearchReleaseIdentity(identity: SearchReleaseIdentity): string {
  return `${identity.schemaVersion} · ${identity.generatedAt}`;
}

export function sameSearchReleaseIdentity(left: SearchReleaseIdentity, right: SearchReleaseIdentity): boolean {
  return left.schemaVersion === right.schemaVersion && left.generatedAt === right.generatedAt && left.searchIndexSha256 === right.searchIndexSha256;
}

export function classifySearchError(error: unknown): SearchIndexFailureKind {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === 'http' || kind === 'malformed' || kind === 'schema' || kind === 'stale-release' ? kind : 'unavailable';
}
