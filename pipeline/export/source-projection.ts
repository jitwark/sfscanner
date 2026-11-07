import type { Entry } from '@hub/contracts';
import type { PublicSourceRow } from '@hub/contracts/public-data-model';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

export function sourceRow(entries: readonly Entry[], sourceId: string): PublicSourceRow {
  if (entries.length === 0) throw new Error('Public projection: source group cannot be empty');
  const ordered = [...entries].sort((left, right) => compareCanonicalStrings(left.source.permalink, right.source.permalink));
  const first = ordered[0]!;
  const licenceMatches = ordered.every((entry) => entry.rights.licence === first.rights.licence && entry.rights.licenceUrl === first.rights.licenceUrl);
  return {
    sourceId,
    kind: first.source.kind === 'n8n_official' ? 'official' : 'community',
    publicUrl: first.source.permalink,
    repositoryUrl: first.source.repo ? `https://github.com/${first.source.repo}` : null,
    licence: licenceMatches ? first.rights.licence : null,
    licenceUrl: licenceMatches ? first.rights.licenceUrl : null,
  };
}
