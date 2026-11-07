import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findAcquireState } from './acquire-resume-guard.js';
import { createHttpState, type HttpOptions, type HttpState } from './official-http.js';
import { fetchByIds, parseIdList, workflowUrl } from './official-pages.js';
import { appendWorkflows, atomicJson, loadWorkflowIds, type StoredWorkflow } from './official-store.js';

/**
 * The targeted run: fetch exactly the ids in a file, and nothing else.
 *
 *   npx tsx pipeline/acquire/fetch-ids.ts --ids <file> --out <dir> [--concurrency N] [--resume]
 *
 * This is not the crawl and cannot become it. It never calls `acquireOfficial`,
 * never reads or writes a cursor or an entries file, and both of its paths are
 * required arguments with no defaults, so there is no state on disk it could
 * pick up by accident. Its store is named apart from the crawl's, and
 * `n8n-official.ts` refuses `--ids` outright so the two cannot be confused in
 * the other direction either.
 */
export const IDS_WORKFLOWS_FILE = 'official-ids-workflows.jsonl';
export const IDS_SUMMARY_FILE = 'official-ids-run.json';

const DEFAULT_CONCURRENCY = 12;
/**
 * Bodies per checkpoint. The crawl checkpoints per page; a targeted run asks
 * for ~1,200 ids in one go, and losing an hour of fetching to one kill is not
 * a trade this makes.
 */
const IDS_PER_CHECKPOINT = 100;

export type IdsOptions = HttpOptions & {
  /** File of ids: one per line, or a JSON array. */
  ids: string;
  /** This run's folder. Required: never defaulted into the crawl's namespace. */
  out: string;
  concurrency?: number;
  /** Explicit opt-in to continue a targeted run that already wrote here. */
  resume?: boolean;
};

export type IdsRun = {
  requested: number;
  skipped: number;
  fetched: number;
  gone: number;
  failed: number;
  workflowsPath: string;
  summaryPath: string;
};

/**
 * Records the last status each URL answered with. `requestJson` hands back a
 * body for 2xx and throws `HttpStatusError` otherwise, so the status is not
 * otherwise visible to a caller whose whole job is to record it. This wraps the
 * transport; it does not retry, pace, or decide anything.
 */
function statusRecorder(options: HttpOptions): { fetchImpl: typeof fetch; statusOf: (url: string) => number } {
  const statuses = new Map<string, number>();
  const inner = options.fetchImpl ?? fetch;
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await inner(input, init);
    statuses.set(input, response.status);
    return response;
  }) as typeof fetch;
  return { fetchImpl, statusOf: (url) => statuses.get(url) ?? 0 };
}

export async function fetchIds(options: IdsOptions): Promise<IdsRun> {
  if (!options.out) {
    throw new Error('--out <dir> is required: a targeted run never picks a folder for itself');
  }
  const workflowsPath = join(options.out, IDS_WORKFLOWS_FILE);
  const summaryPath = join(options.out, IDS_SUMMARY_FILE);

  const wanted = parseIdList(await readFile(options.ids, 'utf8'));
  if (wanted.length === 0) throw new Error(`no template ids in ${options.ids}`);

  // A crawl's folder already means something else. Writing this run's store
  // beside that cursor would make two acquisitions look like one run.
  const crawlState = await findAcquireState(options.out);
  if (crawlState.length > 0) {
    throw new Error(
      `${options.out} holds crawl state (${crawlState.join(', ')}); a targeted run must not write into it. Pick another --out.`,
    );
  }

  const already = await loadWorkflowIds(workflowsPath);
  if (already.size > 0 && !options.resume) {
    throw new Error(
      `${workflowsPath} already holds ${already.size} id(s) from a previous targeted run. ` +
        'Pass --resume to continue it, or pick another --out.',
    );
  }

  const todo = wanted.filter((id) => !already.has(id));
  const now = options.now ?? Date.now;
  const state: HttpState = createHttpState(options.concurrency ?? DEFAULT_CONCURRENCY);
  const { fetchImpl, statusOf } = statusRecorder(options);

  await mkdir(options.out, { recursive: true });

  const counts = { fetched: 0, gone: 0, failed: 0 };
  for (let start = 0; start < todo.length; start += IDS_PER_CHECKPOINT) {
    const batch = todo.slice(start, start + IDS_PER_CHECKPOINT);
    const fetchedAt = new Date(now()).toISOString();
    const results = await fetchByIds(batch, { ...options, fetchImpl }, state);

    const records: StoredWorkflow[] = results.map((item) => {
      const url = workflowUrl(item.id);
      counts[item.reason === 'ok' ? 'fetched' : item.reason] += 1;
      return {
        templateId: item.id,
        workflow: item.reason === 'ok' ? item.workflow : null,
        provenance: { url, fetchedAt, httpStatus: statusOf(url), reason: item.reason },
      };
    });

    // Store first, then the counts. A kill can only leave the store ahead of
    // the summary, never behind it — a body with no receipt is recoverable, a
    // receipt for a body that was never stored is not.
    await appendWorkflows(workflowsPath, records);
    await atomicJson(summaryPath, {
      idsFile: options.ids,
      requested: todo.length,
      skipped: already.size,
      ...counts,
      workflows: workflowsPath,
    });
  }

  return {
    requested: todo.length,
    skipped: already.size,
    ...counts,
    workflowsPath,
    summaryPath,
  };
}

function cliArgs(argv: readonly string[]): { ids: string; out: string; concurrency?: number; resume: boolean } {
  const value = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
  };
  const ids = value('--ids');
  if (!ids) throw new Error('--ids <file> is required: a targeted run fetches an explicit list, never a range');
  const out = value('--out');
  if (!out) throw new Error('--out <dir> is required: a targeted run never picks a folder for itself');
  const concurrency = Number(value('--concurrency'));
  return {
    ids,
    out,
    ...(Number.isFinite(concurrency) && concurrency > 0 ? { concurrency } : {}),
    resume: argv.includes('--resume'),
  };
}

if (process.argv[1]?.endsWith('fetch-ids.ts') || process.argv[1]?.endsWith('fetch-ids.js')) {
  try {
    const args = cliArgs(process.argv.slice(2));
    fetchIds(args)
      .then((run) => {
        console.log(JSON.stringify(run));
      })
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : 'targeted fetch failed');
        process.exitCode = 1;
      });
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'targeted fetch failed');
    process.exitCode = 1;
  }
}
