import type { Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

function prerenderScore(entry: Entry): number {
  const integrations = Math.min(entry.structure?.integrations?.length ?? 0, 8) * 0.03;
  const nodes = Math.min(entry.structure?.nodeCount ?? 0, 60) * 0.01;
  const rights = entry.rights?.status === 'redistributable' ? 0.15 : 0;
  const description = entry.descriptionSource !== 'fallback' ? 0.15 : -0.1;
  const critical = entry.security?.grade === 'CRITICAL' ? -0.15 : 0;
  return 1 + integrations + nodes + rights + description + critical;
}

export function selectPrerenderedIds(entries: Entry[], limit: number): Set<string> {
  return new Set(
    [...entries]
      .sort((a, b) => prerenderScore(b) - prerenderScore(a) || compareCanonicalStrings(a.id, b.id))
      .slice(0, limit)
      .map((entry) => entry.id),
  );
}
