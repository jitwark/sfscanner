import fs from 'node:fs';
import path from 'node:path';

/**
 * Choose detail-page subjects by **page type**, from the corpus, at test time.
 *
 * A workflow gets one of two pages. The top 250 by quality are prerendered by
 * Next and render the canvas inline under a "Workflow canvas" heading; every
 * other entry gets a lean page from `scripts/generate-lean-pages.tsx`, which
 * shows the same static preview under the same "Workflow canvas" heading and
 * defers the canvas behind an "Open the interactive view" link. The specs that
 * assert canvas opt-in are asserting the *lean* contract, and it does not exist
 * on the other page.
 *
 * Which entries land in which set is a function of the corpus. Withholding
 * 1,757 unrenderable entries on 2026-09-04 moved three hardcoded representatives
 * from lean to prerendered and broke twenty specs that had encoded the old
 * assignment — as ids in one place and as "the first link-only result" in
 * another. Filtering by `rights=link_only` did not help, and the comment saying
 * it would was wrong: 97.5% of the corpus is link-only, prerendered entries
 * included.
 *
 * So subjects are derived here, from the same `app/public/data/` the site reads,
 * by the property each spec actually needs.
 */
export type DetailSubject = {
  id: string;
  slug: string;
  title: string;
  nodeCount: number;
  annotationNodeCount: number;
  /** False for a lean page — the one that defers its canvas. */
  isPrerendered: boolean;
  /**
   * The byte range this entry's download control asks its pack shard for, or
   * null when the entry is link-only and the page offers no file at all. The
   * range is the contract the static behaviour script fetches, so a spec that
   * asserts it has to read it from the same artifact the site renders from.
   */
  download: { pack: number; offset: number; length: number } | null;
};

// `__dirname`, not `import.meta.dirname`: Playwright loads specs as CommonJS,
// where `import.meta` is a syntax error. `playwright.config.ts` carries the
// same note and the same workaround for the same reason.
const dataDir = path.resolve(__dirname, '..', 'public', 'data');

let cache: DetailSubject[] | null = null;

function loadCatalogue(): DetailSubject[] {
  if (cache) return cache;
  const entries: DetailSubject[] = [];
  for (let shard = 0; ; shard += 1) {
    const shardPath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(shardPath)) break;
    for (const entry of JSON.parse(fs.readFileSync(shardPath, 'utf8'))) {
      entries.push({
        id: entry.id,
        slug: entry.slug,
        title: entry.title ?? '',
        nodeCount: entry.structure?.nodeCount ?? 0,
        annotationNodeCount: entry.structure?.annotationNodeCount ?? 0,
        isPrerendered: entry.isPrerendered === true,
        download: entry.download
          ? { pack: entry.download.pack, offset: entry.download.offset, length: entry.download.length }
          : null,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error(
      `No catalogue shards in ${dataDir}. Run \`npm run sync:data\` — the e2e suite reads the same artifacts the site does.`,
    );
  }
  cache = entries;
  return entries;
}

export function leanSubjects(): DetailSubject[] {
  return loadCatalogue().filter((entry) => !entry.isPrerendered);
}

/**
 * A stable, corpus-derived spread of lean pages, one per graph shape.
 *
 * The shapes are the point — a small graph, the largest, the most
 * annotation-heavy, the longest title — so each pick excludes what is already
 * chosen. Without that, the largest graph and the most annotated one are the
 * same entry today and the suite would quietly lose a case. Ties break on id so
 * the selection cannot depend on shard iteration order.
 */
export function leanRepresentatives(): DetailSubject[] {
  const lean = leanSubjects();
  const byId = (left: DetailSubject, right: DetailSubject) => (left.id < right.id ? -1 : 1);
  const chosen = new Map<string, DetailSubject>();

  const take = (candidates: DetailSubject[]) => {
    const pick = candidates.find((entry) => !chosen.has(entry.id));
    if (pick) chosen.set(pick.id, pick);
  };

  const bySize = [...lean].sort((a, b) => a.nodeCount - b.nodeCount || byId(a, b));
  // A one-node graph exercises none of what these specs are about, so the small
  // end is the smallest graph that still has something to draw.
  take(bySize.filter((entry) => entry.nodeCount >= 5));
  take([...bySize].reverse());
  take([...lean].sort((a, b) => b.annotationNodeCount - a.annotationNodeCount || byId(a, b)));
  take([...lean].sort((a, b) => b.title.length - a.title.length || byId(a, b)));
  // A mid-sized graph: the common case, and the one the other four are not.
  take([bySize[Math.floor(bySize.length / 2)]!]);

  return [...chosen.values()];
}

/** The largest lean graph — the binding case for canvas performance. */
export function largestLeanSubject(): DetailSubject {
  return leanSubjects().reduce((worst, entry) => (entry.nodeCount > worst.nodeCount ? entry : worst));
}

/** The most annotation-heavy lean graph — sticky notes are not functional nodes. */
export function mostAnnotatedLeanSubject(): DetailSubject {
  return leanSubjects().reduce(
    (worst, entry) => (entry.annotationNodeCount > worst.annotationNodeCount ? entry : worst),
  );
}

/**
 * The first lean page, by id.
 *
 * Specs previously reached this through the library's first `rights=link_only`
 * card, which is a quality ordering and says nothing about page type.
 */
export function firstLeanSubject(): DetailSubject {
  return [...leanSubjects()].sort((left, right) => (left.id < right.id ? -1 : 1))[0]!;
}

/**
 * The first prerendered page, by id.
 *
 * Prerendered pages are the only detail pages Next hydrates. Lean pages are
 * generated HTML without React (`scripts/generate-lean-pages.tsx` plus the
 * static behaviour script), so a spec that drives the hydrated
 * `src/ui/detail/canvas-viewport.tsx` has to hold one of these rather than a
 * lean page.
 */
export function firstPrerenderedSubject(): DetailSubject {
  return [...loadCatalogue()]
    .filter((entry) => entry.isPrerendered)
    .sort((left, right) => (left.id < right.id ? -1 : 1))[0]!;
}
