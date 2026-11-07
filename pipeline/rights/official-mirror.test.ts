import { describe, expect, it } from 'vitest';
import type { EntryRights } from '@hub/contracts';
import { demoteOfficialMirrors, OFFICIAL_MIRROR_REASON, type MirrorCandidate } from './official-mirror.js';

function candidate(
  id: string,
  kind: 'github' | 'n8n_official',
  structuralHash: string,
  rights: Partial<EntryRights> = {},
): MirrorCandidate & { id: string } {
  return {
    id,
    source: { kind },
    rights: {
      status: kind === 'n8n_official' ? 'link_only' : 'redistributable',
      licence: kind === 'n8n_official' ? null : 'MIT',
      licenceUrl: null,
      reason: kind === 'n8n_official' ? 'official n8n template' : 'repository licence: MIT',
      ...rights,
    },
    dedup: { structuralHash, fingerprint: `fp-${id}` },
  };
}

describe('demoteOfficialMirrors', () => {
  it('demotes a redistributable copy that is also an official template', () => {
    // A repository licence covers what the repo owner wrote. When the identical
    // workflow is published in n8n's own library, the uploader was not in a
    // position to grant MIT over it, whatever the LICENSE file says.
    const github = candidate('gh-1', 'github', 'sh-shared');
    const official = candidate('off-1', 'n8n_official', 'sh-shared');

    const result = demoteOfficialMirrors([github, official]);

    expect(result.demoted).toBe(1);
    expect(result.groups).toBe(1);
    expect(github.rights.status).toBe('link_only');
    expect(github.rights.reason).toBe(OFFICIAL_MIRROR_REASON);
    // The claimed licence is kept so the page can still report what the
    // repository asserted; only our willingness to redistribute changes.
    expect(github.rights.licence).toBe('MIT');
  });

  it('leaves a workflow that is not in the official library alone', () => {
    const github = candidate('gh-2', 'github', 'sh-unique');
    const official = candidate('off-2', 'n8n_official', 'sh-other');

    const result = demoteOfficialMirrors([github, official]);

    expect(result.demoted).toBe(0);
    expect(github.rights.status).toBe('redistributable');
    expect(github.rights.reason).toBe('repository licence: MIT');
  });

  it('never rewrites the official entry itself', () => {
    const official = candidate('off-3', 'n8n_official', 'sh-shared');
    const github = candidate('gh-3', 'github', 'sh-shared');

    demoteOfficialMirrors([github, official]);

    expect(official.rights.reason).toBe('official n8n template');
    expect(official.rights.status).toBe('link_only');
  });

  it('does not overwrite the reason on a candidate that was already link-only', () => {
    const github = candidate('gh-4', 'github', 'sh-shared', {
      status: 'link_only',
      reason: 'no licence file',
    });
    const official = candidate('off-4', 'n8n_official', 'sh-shared');

    const result = demoteOfficialMirrors([github, official]);

    expect(result.demoted).toBe(0);
    expect(github.rights.reason).toBe('no licence file');
  });

  it('demotes every redistributable member of a shared group', () => {
    const a = candidate('gh-5a', 'github', 'sh-shared');
    const b = candidate('gh-5b', 'github', 'sh-shared');
    const c = candidate('gh-5c', 'github', 'sh-elsewhere');
    const official = candidate('off-5', 'n8n_official', 'sh-shared');

    const result = demoteOfficialMirrors([a, b, c, official]);

    expect(result.demoted).toBe(2);
    expect(a.rights.status).toBe('link_only');
    expect(b.rights.status).toBe('link_only');
    expect(c.rights.status).toBe('redistributable');
  });

  it('ignores candidates with no structural hash rather than grouping them together', () => {
    // An empty hash is "we could not compute one", not "identical to every
    // other workflow that also could not". Treating those as one group is the
    // defect that collapsed 11,490 official templates into a single entry.
    const github = candidate('gh-6', 'github', '');
    const official = candidate('off-6', 'n8n_official', '');

    const result = demoteOfficialMirrors([github, official]);

    expect(result.demoted).toBe(0);
    expect(github.rights.status).toBe('redistributable');
  });

  it('returns zero counts for an empty corpus', () => {
    expect(demoteOfficialMirrors([])).toEqual({ demoted: 0, groups: 0 });
  });
});
