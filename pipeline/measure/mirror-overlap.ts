/**
 * Which source repositories are mirrors of the official n8n template library?
 *
 * Not from their README, and not from the licence file they shipped — from
 * dedup. `candidatesAlsoOnN8nIo` counts a repo's files that sit in a dedup
 * group which also holds an official template, whoever won that group. That is
 * the headline number and the one to trust.
 *
 * `canonicalsMirroringOfficial` is reported beside it and is the narrower
 * question of what a repo's *winning* entries absorbed. Do not read it as the
 * mirror share: it is conditional on winning, so a repo that mirrors n8n.io and
 * loses every group to another mirror scores 0% and looks clean.
 *
 * This matters because `decideRights` trusts the repository's own SPDX id, and
 * a repository cannot license work it does not own. A high overlap means the
 * repo's LICENSE file is making a claim about someone else's material.
 *
 * Usage: npx tsx pipeline/measure/mirror-overlap.ts [runId]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

type Row = {
  entry: {
    id: string;
    source?: { kind?: string; repo?: string };
    rights?: { status?: string; licence?: string | null };
    dedup?: { canonical?: boolean; alsoFoundIn?: string[]; duplicateOf?: string };
    download?: unknown;
  };
};

/**
 * Every candidate, tagged with the dedup group it ended up in. Counting only
 * the `alsoFoundIn` of canonical entries measures something narrower and
 * misleading: it is conditional on winning the election, so a repo that
 * mirrors n8n.io but loses every group to another mirror scores 0% and reads
 * as clean. Group membership does not have that bias.
 */
const membership: Array<{ group: string; repo: string; official: boolean }> = [];

const runId = process.argv[2] ?? 'rederive-65';

type Stat = {
  candidates: number;
  canonicals: number;
  canonicalsWithOfficialLink: number;
  officialLinksAbsorbed: number;
  redistributableCanonicals: number;
  licence: string | null;
};

const bySource = new Map<string, Stat>();

function statFor(key: string): Stat {
  let stat = bySource.get(key);
  if (!stat) {
    stat = {
      candidates: 0,
      canonicals: 0,
      canonicalsWithOfficialLink: 0,
      officialLinksAbsorbed: 0,
      redistributableCanonicals: 0,
      licence: null,
    };
    bySource.set(key, stat);
  }
  return stat;
}

const reader = createInterface({
  input: createReadStream(`pipeline/.work/${runId}/entries.json`, { encoding: 'utf8' }),
  crlfDelay: Number.POSITIVE_INFINITY,
});

let buffer: string[] = [];
let inRecord = false;

for await (const line of reader) {
  if (!inRecord) {
    if (line !== '  {') continue;
    inRecord = true;
    buffer = [line];
    continue;
  }
  buffer.push(line);
  if (line !== '  }' && line !== '  },') continue;
  inRecord = false;

  const row = JSON.parse(buffer.join('\n').replace(/,$/, '')) as Row;
  const entry = row.entry;
  const key = entry.source?.kind === 'n8n_official' ? 'n8n_official' : entry.source?.repo ?? 'unknown';
  const stat = statFor(key);
  stat.candidates += 1;
  if (entry.rights?.licence) stat.licence = entry.rights.licence;
  membership.push({
    group: entry.dedup?.canonical === true ? entry.id : entry.dedup?.duplicateOf ?? entry.id,
    repo: key,
    official: entry.source?.kind === 'n8n_official',
  });
  if (entry.dedup?.canonical !== true) continue;
  stat.canonicals += 1;
  if (entry.rights?.status === 'redistributable') stat.redistributableCanonicals += 1;
  const officialLinks = (entry.dedup.alsoFoundIn ?? []).filter((url) => url.includes('n8n.io/workflows/'));
  if (officialLinks.length > 0) stat.canonicalsWithOfficialLink += 1;
  stat.officialLinksAbsorbed += officialLinks.length;
}

const groupsWithOfficial = new Set<string>();
for (const m of membership) {
  if (m.official) groupsWithOfficial.add(m.group);
}

const candidatesInOfficialGroup = new Map<string, number>();
for (const m of membership) {
  if (m.official || !groupsWithOfficial.has(m.group)) continue;
  candidatesInOfficialGroup.set(m.repo, (candidatesInOfficialGroup.get(m.repo) ?? 0) + 1);
}

const rows = [...bySource.entries()]
  .map(([source, s]) => {
    const shared = candidatesInOfficialGroup.get(source) ?? 0;
    return {
      source,
      licence: s.licence,
      candidates: s.candidates,
      canonicals: s.canonicals,
      redistributableCanonicals: s.redistributableCanonicals,
      // The unbiased measure: candidates sitting in a dedup group that also
      // holds an official template, whoever won that group.
      candidatesAlsoOnN8nIo: shared,
      shareOfRepoFromN8nIo: `${((shared / (s.candidates || 1)) * 100).toFixed(1)}%`,
      canonicalsMirroringOfficial: s.canonicalsWithOfficialLink,
      officialLinksAbsorbed: s.officialLinksAbsorbed,
    };
  })
  .sort((a, b) => b.candidatesAlsoOnN8nIo - a.candidatesAlsoOnN8nIo);

console.log(JSON.stringify({ runId, rows }, null, 1));
