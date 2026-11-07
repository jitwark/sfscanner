import type {
  Candidate,
  Entry,
  EntryDedup,
  EntryReadiness,
  EntrySecurity,
  EntryStructure,
  EntryWithChart,
  HostnameExtraction,
  N8nCompatibility,
  WorkflowChart,
} from '@hub/contracts';
import { assertKnownRightsStatus } from '@hub/contracts';
import { demoteOfficialMirrors, type MirrorDemotion } from '../rights/official-mirror.js';
import { elect, type CandidateWithDedup, type ElectResult } from '../dedup/elect.js';
import { fingerprint, structuralHash, canonicalizeJsonForHash } from '../dedup/signatures.js';
import { redactPublicText } from '../enrich/public-text.js';
import { slugify } from '../acquire/entry-id.js';
import { appendStageRecord } from '../stage-ledger.js';
import { sha256 } from './run-context.js';

export type DedupStageOptions = {
  candidates: Candidate[];
  ledgerPath: string;
};

export type DedupedCandidate = CandidateWithDedup & { dedup: EntryDedup };

export type DedupStageResult = {
  /** The deduped candidates the write stage publishes from. */
  candidates: DedupedCandidate[];
  entriesWithChart: EntryWithChart[];
  electionStats: ElectResult['stats'];
  mirrorDemotion: MirrorDemotion;
};

/**
 * STAGE 4: DEDUP & ASSEMBLY — hash every candidate, withdraw redistribution
 * from the ones that are also published on n8n.io, elect one canonical per
 * group, and turn the survivors into publishable entries.
 */
export async function runDedupStage(options: DedupStageOptions): Promise<DedupStageResult> {
  const { candidates, ledgerPath } = options;

  // Every branch below assigns `dedup`, so narrow it to required here rather
  // than defending against undefined at three later use sites.
  const candidatesWithDedup: DedupedCandidate[] = candidates.map((c) => {
    let fp = '';
    let sh = '';
    if (c.json) {
      fp = fingerprint(c.json);
      sh = structuralHash(c.json);
    } else {
      fp = sha256('n8n_official:' + (c.source.templateId ?? c.id));
      const structNodeTypes = (c as unknown as Record<string, unknown>).structure
        ? ((c as unknown as Record<string, unknown>).structure as EntryStructure).nodeTypes
        : [];
      sh = sha256(JSON.stringify(structNodeTypes));
    }

    const struct = (c as unknown as Record<string, unknown>).structure as EntryStructure;
    return {
      ...c,
      tags: struct?.integrations ?? [],
      dedup: {
        fingerprint: fp,
        structuralHash: sh,
        canonical: false,
        alsoFoundIn: [],
      },
    };
  });

  // Rights, revisited with what dedup now knows. This has to run before the
  // election: once both the mirror and the official template are link-only,
  // the official entry wins on metadata and the page points at n8n.io.
  const mirrorDemotion = demoteOfficialMirrors(candidatesWithDedup);

  const electRes = elect(candidatesWithDedup);

  // `elect` returns the decided candidates; the pre-election array still carries
  // `canonical: false` on every item. Index the decisions by id and apply them,
  // otherwise nothing is ever publishable.
  const decidedById: Record<string, CandidateWithDedup> = {};
  for (const decided of [...electRes.canonical, ...electRes.duplicates]) {
    decidedById[decided.id] = decided;
  }
  for (const candidate of candidatesWithDedup) {
    const decided = decidedById[candidate.id];
    if (decided?.dedup) candidate.dedup = decided.dedup;
  }

  // Record ledger for dedup stage
  for (const c of candidatesWithDedup) {
    const inputHash = sha256(c.id + ':dedup:' + c.dedup.canonical);
    await appendStageRecord(ledgerPath, { entryId: c.id, stage: 'dedup', ok: true, inputHash, outputHash: sha256(canonicalizeJsonForHash(c.dedup)) });
  }

  // Turn into EntryWithChart[]
  const entriesWithChart: EntryWithChart[] = candidatesWithDedup.map((c) => {
    const struct = (c as unknown as Record<string, unknown>).structure as EntryStructure;
    const sec = (c as unknown as Record<string, unknown>).security as EntrySecurity;
    const chart = ((c as unknown as Record<string, unknown>).chart as WorkflowChart) || { nodes: [], edges: [] };
    // Spread only when present. A candidate acquired from metadata alone has no
    // workflow JSON, and an absent readiness report is the truthful answer;
    // an empty one would render as "nothing to connect, nothing to replace".
    const readiness = (c as unknown as Record<string, unknown>).readiness as EntryReadiness | undefined;
    const hostnames = (c as unknown as Record<string, unknown>).hostnames as HostnameExtraction | undefined;
    const compatibility = (c as unknown as Record<string, unknown>).compatibility as N8nCompatibility | undefined; const publicDescription = c.upstreamDescription ? redactPublicText(c.upstreamDescription) : undefined;

    // Validated at entry construction, not just at export (rights-and-exclusion spec): an unrecognized status throws here, naming the record.
    assertKnownRightsStatus(c.rights.status, c.id);

    const entry: Entry = {
      id: c.id,
      slug: slugify(c.title, c.id),
      title: c.title,
      summary: publicDescription?.split(/[.!?]\s/u, 1)[0]?.trim() || c.title,
      description: publicDescription || c.title,
      descriptionSource: c.upstreamDescription ? 'upstream' : 'fallback',
      source: c.source,
      rights: c.rights,
      structure: struct,
      ...(readiness ? { readiness } : {}),
      ...(hostnames ? { hostnames } : {}),
      ...(compatibility ? { compatibility } : {}),
      security: sec,
      tags: c.tags || [],
      dedup: c.dedup,
    };

    return { entry, chart };
  });

  return {
    candidates: candidatesWithDedup,
    entriesWithChart,
    electionStats: electRes.stats,
    mirrorDemotion,
  };
}
