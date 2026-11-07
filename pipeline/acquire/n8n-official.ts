import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntryWithChart } from '@hub/contracts';
import { createHttpState, requestJson, type HttpOptions } from './official-http.js';
import { appendWorkflows, atomicJson, workflowStorePath, type StoredWorkflow } from './official-store.js';
import {
  analyseWorkflow,
  buildEntry,
  metadataStructure,
  responseTemplates,
  templateId,
  type Analysis,
} from './official-entry.js';
import { API, assertCrawlArgs, fetchPageBodies, uniqueTemplateIds } from './official-pages.js';

type OfficialOptions = HttpOptions & {
  runId: string;
  limit?: number;
  workDir?: string;
  rows?: number;
  /** Detail fetches in flight. Pages stay sequential. Halved on any 429. */
  concurrency?: number;
};

type Acquisition = {
  entries: EntryWithChart[];
  total: number;
  pages: number;
  /** Append-only JSONL of retained workflow bodies, keyed by templateId. */
  workflowsPath: string;
  /** Templates whose body could not be fetched, so structure is `partial`. */
  bodiesMissing: number;
  /** Of those, the ones the API answered 404 for: deleted upstream, not our failure. */
  bodiesGone: number;
};

const DEFAULT_CONCURRENCY = 12;

export async function acquireOfficial(options: OfficialOptions): Promise<Acquisition> {
  const rows = options.rows ?? 100;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const work = options.workDir ?? join('pipeline', '.work', options.runId);
  const cursorPath = join(work, 'official-cursor.json');
  // Deliberately NOT `entries.json`. `build-corpus` writes the whole combined
  // corpus to that name at the end of a run, so sharing it meant a completed
  // run left a file this function would read back as its own partial progress.
  // A re-run would then load every GitHub entry as an already-acquired official
  // template and append pages on top of them. The cursor and the workflow store
  // are paired with this file, so all three must be named independently.
  const entriesPath = join(work, 'official-entries.json');
  const workflowsPath = workflowStorePath(work);

  await mkdir(work, { recursive: true });

  let page = 1;
  let total = 0;
  let entries: EntryWithChart[] = [];
  let bodiesMissing = 0;
  let bodiesGone = 0;

  try {
    const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as Record<string, unknown>;
    if (typeof cursor.nextPage === 'number') page = cursor.nextPage;
    if (typeof cursor.total === 'number') total = cursor.total;
    if (typeof cursor.bodiesMissing === 'number') bodiesMissing = cursor.bodiesMissing;
    if (typeof cursor.bodiesGone === 'number') bodiesGone = cursor.bodiesGone;

    const loadedEntries = JSON.parse(await readFile(entriesPath, 'utf8'));
    if (Array.isArray(loadedEntries)) entries = uniqueTemplateIds(loadedEntries as EntryWithChart[]);
  } catch {
    // Fresh run
  }

  if (entries.length >= limit) {
    return { entries: entries.slice(0, limit), total, pages: page - 1, workflowsPath, bodiesMissing, bodiesGone };
  }

  const state = createHttpState(options.concurrency ?? DEFAULT_CONCURRENCY);
  const nowFn = options.now ?? Date.now;
  let pages = page - 1;

  while (entries.length < limit) {
    const payload = (await requestJson(`${API}/search?page=${page}&rows=${rows}`, options, state)) as Record<string, unknown>;
    const templates = responseTemplates(payload);
    const apiTotal = typeof payload.totalWorkflows === 'number'
      ? payload.totalWorkflows
      : typeof payload.total === 'number' ? payload.total : 0;
    if (apiTotal > 0) total = apiTotal;
    if (!templates.length) break;

    const room = limit - entries.length;
    const seen = new Set(entries.map((item) => item.entry.source.templateId));
    const wanted = templates
      .filter((template) => {
        const id = templateId(template);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, Math.max(0, Math.min(templates.length, room)));
    const fetched = await fetchPageBodies(wanted, options, state);

    const bodies: StoredWorkflow[] = [];
    for (const item of fetched) {
      let analysis: Analysis;
      if (item.workflow) {
        analysis = analyseWorkflow(item.workflow);
        bodies.push({ templateId: item.id, workflow: item.workflow });
      } else {
        analysis = metadataStructure(item.template);
        bodiesMissing += 1;
        if (item.reason === 'gone') bodiesGone += 1;
      }
      entries.push(buildEntry(item.template, new Date(nowFn()).toISOString(), analysis));
    }

    pages = page;
    page += 1;

    // Bodies first, then metadata, then the cursor. A kill can only leave
    // bodies ahead of the cursor — never behind it, which would silently
    // publish an entry whose workflow was never stored.
    await appendWorkflows(workflowsPath, bodies);
    await atomicJson(entriesPath, entries);
    await atomicJson(cursorPath, { nextPage: page, total, bodiesMissing, bodiesGone });

    if (templates.length < rows || (total > 0 && entries.length >= total)) {
      break;
    }
  }

  return { entries: entries.slice(0, limit), total, pages, workflowsPath, bodiesMissing, bodiesGone };
}

function cliArgs(argv: string[]): { runId: string; limit?: number; concurrency?: number } {
  const value = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
  };
  const limit = Number(value('--limit'));
  const concurrency = Number(value('--concurrency'));
  return {
    runId: value('--run') ?? 'official',
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isFinite(concurrency) && concurrency > 0 ? { concurrency } : {}),
  };
}

if (process.argv[1]?.endsWith('n8n-official.ts') || process.argv[1]?.endsWith('n8n-official.js')) {
  const argv = process.argv.slice(2);
  try {
    // A targeted run is a different tool. Without this, `--ids` would be
    // ignored here and the caller would get a full crawl under a targeted
    // run's name.
    assertCrawlArgs(argv);
    const started = Date.now();
    acquireOfficial(cliArgs(argv))
      .then(result => {
        console.log(JSON.stringify({
          total: result.total,
          entries: result.entries.length,
          pages: result.pages,
          bodiesMissing: result.bodiesMissing,
          bodiesGone: result.bodiesGone,
          workflowsPath: result.workflowsPath,
          elapsedMs: Date.now() - started,
        }));
      })
      .catch(err => {
        console.error(err instanceof Error ? err.message : 'official acquisition failed');
        process.exitCode = 1;
      });
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'official acquisition failed');
    process.exitCode = 1;
  }
}
