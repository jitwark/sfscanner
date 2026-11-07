import type { EntryWithChart } from '@hub/contracts';
import { HttpStatusError, mapPool, requestJson, type HttpOptions } from './official-http.js';
import { extractWorkflow, templateId } from './official-entry.js';

/**
 * Page-level fetching for the official n8n template API.
 *
 * `n8n-official.ts` owns the resume cursor, the workflow store and the CLI.
 * This module owns the two things that happen *within* a single page: deciding
 * which templates on it are new, and fetching their bodies concurrently.
 */

export const API = 'https://api.n8n.io/api/templates';

/** The detail URL for one template. Built in one place so the crawl and a
 * targeted run cannot drift apart on where a body comes from. */
export function workflowUrl(id: number): string {
  return `${API}/workflows/${id}`;
}

export type Fetched = {
  template: Record<string, unknown>;
  id: number;
  workflow: Record<string, unknown> | null;
  /** `gone` = upstream 404, the template no longer exists. `failed` = our side. */
  reason: 'ok' | 'gone' | 'failed';
};

/**
 * Drop entries whose templateId has already been seen. Entries without a
 * numeric templateId are kept — they are not official templates and this
 * de-duplication does not apply to them.
 */
export function uniqueTemplateIds(entries: EntryWithChart[]): EntryWithChart[] {
  const seen = new Set<number>();
  return entries.filter((item) => {
    const id = item.entry.source.templateId;
    if (typeof id !== 'number' || seen.has(id)) return typeof id !== 'number';
    seen.add(id);
    return true;
  });
}

export async function fetchPageBodies(
  templates: Record<string, unknown>[],
  options: HttpOptions,
  state: { concurrency: number },
): Promise<Fetched[]> {
  return mapPool(
    templates,
    async (template): Promise<Fetched> => {
      const id = templateId(template);
      try {
        const payload = await requestJson(workflowUrl(id), options, state);
        return { template, id, workflow: extractWorkflow(payload), reason: 'ok' };
      } catch (err) {
        // Measured against the live API: a template deleted upstream answers
        // 404 `NotFoundError` on some ids and 400 `BadRequestError` with the
        // message "Not found" on others. Both mean gone — the public
        // n8n.io/workflows/<id> page 404s for them too — and neither is a
        // failure on our side. Our request shape is fixed, so a 400 cannot
        // mean we sent something malformed.
        const gone = err instanceof HttpStatusError && (err.status === 404 || err.status === 400);
        return { template, id, workflow: null, reason: gone ? 'gone' : 'failed' };
      }
    },
    () => state.concurrency,
  );
}

/**
 * Fetch exactly the ids in `ids` — the targeted counterpart of a crawl page.
 * The per-request policy is not restated here: these go through the same
 * `fetchPageBodies` a crawl page uses, so backoff, jitter, retries and the
 * 429-driven concurrency halving are literally the same code path.
 */
export async function fetchByIds(
  ids: readonly number[],
  options: HttpOptions,
  state: { concurrency: number },
): Promise<Fetched[]> {
  return fetchPageBodies(
    ids.map((id) => ({ id })),
    options,
    state,
  );
}

const ID_LINE = /^(\d+)$/;

function pushId(ids: Set<number>, value: unknown): void {
  const id = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`not a template id: ${JSON.stringify(value)}`);
  }
  ids.add(id);
}

function pushJsonIds(payload: unknown, ids: Set<number>): void {
  if (!Array.isArray(payload)) throw new Error('an id file must be one id per line or a JSON array');
  for (const item of payload) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      pushId(ids, typeof rec.id === 'number' ? rec.id : rec.templateId);
    } else {
      pushId(ids, item);
    }
  }
}

/**
 * Parse an explicit list of template ids: one per line (blank lines and `#`
 * comments ignored), or a JSON array of ids or of `{ id | templateId }` objects.
 * Ascending and de-duplicated, so a re-run of the same file fetches the same
 * ids in the same order. Anything unparseable throws: a silently skipped id is
 * an id nobody notices is still missing.
 */
export function parseIdList(text: string): number[] {
  const ids = new Set<number>();
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    pushJsonIds(JSON.parse(trimmed), ids);
  } else {
    for (const line of text.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith('#')) continue;
      const match = ID_LINE.exec(entry);
      if (!match) throw new Error(`not a template id: ${JSON.stringify(entry)}`);
      ids.add(Number(match[1]));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * The crawl and the targeted run are separate entry points, and the crawl's CLI
 * ignores flags it does not know. Without this, `n8n-official.ts --ids …` would
 * quietly start a full crawl instead of the run the caller asked for.
 */
export function assertCrawlArgs(argv: readonly string[]): void {
  const targeted = argv.find((arg) => arg === '--ids' || arg.startsWith('--ids='));
  if (targeted) {
    throw new Error(
      `${targeted} is a targeted run, not a crawl: use pipeline/acquire/fetch-ids.ts --ids <file> --out <dir>.`,
    );
  }
}
