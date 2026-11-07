import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCrawlArgs, fetchByIds, parseIdList, workflowUrl } from './official-pages.js';
import { IDS_SUMMARY_FILE, IDS_WORKFLOWS_FILE, fetchIds } from './fetch-ids.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function response(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A detail payload as the live API shapes it: the body one level under `workflow`. */
function detail(id: number, name: string): unknown {
  return { id, name, workflow: { name, nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }], connections: {} } };
}

/** Canned transport. Nothing here reaches the network. */
function stubFetch(routes: Record<string, Response>): typeof fetch {
  return vi.fn(async (input: string) => {
    const url = String(input);
    const hit = routes[url];
    if (!hit) throw new Error(`unmapped URL in stub: ${url}`);
    return hit;
  }) as unknown as typeof fetch;
}

describe('parseIdList', () => {
  it('reads one id per line, ignoring blanks and comments', () => {
    expect(parseIdList('10\n\n# a note\n3\n10\n')).toEqual([3, 10]);
  });

  it('reads a JSON array of ids or id objects, in ascending order', () => {
    expect(parseIdList('[12, {"id": 5}, {"templateId": 7}]')).toEqual([5, 7, 12]);
  });

  it('refuses a line that is not a template id rather than skipping it', () => {
    expect(() => parseIdList('12\nnot-an-id\n')).toThrow(/not a template id/i);
  });
});

describe('fetchByIds', () => {
  it('fetches exactly the ids given and separates gone from fetched', async () => {
    const fetchImpl = stubFetch({
      [workflowUrl(7)]: response(200, detail(7, 'Seven')),
      [workflowUrl(8)]: response(404, { message: 'NotFoundError' }),
    });

    const fetched = await fetchByIds([7, 8], { fetchImpl, sleep: async () => {} }, { concurrency: 2 });

    expect(fetched.map((item) => [item.id, item.reason])).toEqual([[7, 'ok'], [8, 'gone']]);
    expect(fetched[0]?.workflow).toMatchObject({ name: 'Seven' });
    expect(fetched[1]?.workflow).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a 400 "Not found" as gone, not as a failure', async () => {
    const fetchImpl = stubFetch({ [workflowUrl(9)]: response(400, { message: 'Not found' }) });
    const fetched = await fetchByIds([9], { fetchImpl, sleep: async () => {} }, { concurrency: 1 });
    expect(fetched[0]?.reason).toBe('gone');
  });
});

describe('assertCrawlArgs', () => {
  it('refuses the crawl entry point when a targeted flag is present', () => {
    expect(() => assertCrawlArgs(['--run', 'official', '--ids', 'missing.txt'])).toThrow(/fetch-ids\.ts/);
  });

  it('leaves a plain crawl invocation alone', () => {
    expect(() => assertCrawlArgs(['--run', 'official', '--limit', '100'])).not.toThrow();
  });
});

describe('fetchIds', () => {
  async function idsFile(text: string): Promise<string> {
    const dir = await tempDir('fetch-ids-list-');
    const file = path.join(dir, 'ids.txt');
    await writeFile(file, text, 'utf8');
    return file;
  }

  function stubbedRoutes(): Record<string, Response> {
    return {
      [workflowUrl(11)]: response(200, detail(11, 'Eleven')),
      [workflowUrl(12)]: response(404, { message: 'NotFoundError' }),
      [workflowUrl(13)]: response(400, { message: 'Not found' }),
    };
  }

  const clock = { now: () => 0, sleep: async (): Promise<void> => {} };

  it('stores bodies and a provenance row per id, with gone ids carrying no body', async () => {
    const ids = await idsFile('13\n11\n12\n');
    const out = await tempDir('fetch-ids-out-');
    const fetchImpl = stubFetch(stubbedRoutes());

    const run = await fetchIds({ ids, out, fetchImpl, ...clock, concurrency: 2 });

    expect(run).toMatchObject({ requested: 3, fetched: 1, gone: 2, failed: 0 });
    const lines = (await readFile(path.join(out, IDS_WORKFLOWS_FILE), 'utf8')).trim().split('\n').map(
      (line) => JSON.parse(line) as { templateId: number; workflow: unknown; provenance: Record<string, unknown> },
    );
    // Ascending id order, not the file's order: the store stays deterministic.
    expect(lines.map((line) => line.templateId)).toEqual([11, 12, 13]);
    expect(lines[0]?.provenance).toEqual({
      url: workflowUrl(11), fetchedAt: '1970-01-01T00:00:00.000Z', httpStatus: 200, reason: 'ok',
    });
    expect(lines[0]?.workflow).toMatchObject({ name: 'Eleven' });
    expect(lines[1]?.workflow).toBeNull();
    expect(lines[1]?.provenance).toMatchObject({ httpStatus: 404, reason: 'gone' });
    expect(lines[2]?.provenance).toMatchObject({ httpStatus: 400, reason: 'gone' });

    const summary = JSON.parse(await readFile(path.join(out, IDS_SUMMARY_FILE), 'utf8')) as Record<string, unknown>;
    expect(summary).toMatchObject({ requested: 3, fetched: 1, gone: 2, failed: 0, idsFile: ids });
  });

  it('records an unreachable id as failed, never as gone', async () => {
    const ids = await idsFile('21\n');
    const out = await tempDir('fetch-ids-out-');
    const fetchImpl = vi.fn(async () => response(500, {})) as unknown as typeof fetch;

    const run = await fetchIds({ ids, out, fetchImpl, ...clock, maxRetries: 1 });

    expect(run).toMatchObject({ fetched: 0, gone: 0, failed: 1 });
    const line = JSON.parse((await readFile(path.join(out, IDS_WORKFLOWS_FILE), 'utf8')).trim()) as {
      workflow: unknown; provenance: Record<string, unknown>;
    };
    expect(line.workflow).toBeNull();
    expect(line.provenance).toMatchObject({ httpStatus: 500, reason: 'failed' });
  });

  it('refuses a directory that already holds a crawl\'s state', async () => {
    const ids = await idsFile('31\n');
    const out = await tempDir('fetch-ids-out-');
    await writeFile(path.join(out, 'official-cursor.json'), '{}', 'utf8');

    await expect(
      fetchIds({ ids, out, fetchImpl: stubFetch({}), ...clock, resume: true }),
    ).rejects.toThrow(/crawl state/i);
  });

  it('refuses to reuse its own prior output without --resume, and skips stored ids with it', async () => {
    const ids = await idsFile('41\n');
    const out = await tempDir('fetch-ids-out-');
    const first = stubFetch({ [workflowUrl(41)]: response(200, detail(41, 'Forty one')) });
    await fetchIds({ ids, out, fetchImpl: first, ...clock });

    await expect(fetchIds({ ids, out, fetchImpl: stubFetch({}), ...clock })).rejects.toThrow(/--resume/);

    // The list grows between runs: the id already stored is not asked for again.
    await writeFile(ids, '41\n42\n', 'utf8');
    const second = stubFetch({ [workflowUrl(42)]: response(200, detail(42, 'Forty two')) });
    const resumed = await fetchIds({ ids, out, fetchImpl: second, ...clock, resume: true });

    expect(resumed).toMatchObject({ requested: 1, skipped: 1, fetched: 1 });
    expect(second).toHaveBeenCalledTimes(1);
    const lines = (await readFile(path.join(out, IDS_WORKFLOWS_FILE), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('refuses to run without an explicit --out', async () => {
    const ids = await idsFile('51\n');
    await expect(fetchIds({ ids, out: '', fetchImpl: stubFetch({}), ...clock })).rejects.toThrow(/--out/);
  });

  it('refuses an id list that yields nothing', async () => {
    const ids = await idsFile('# only comments\n');
    const out = await tempDir('fetch-ids-out-');
    await expect(fetchIds({ ids, out, fetchImpl: stubFetch({}), ...clock })).rejects.toThrow(/no template ids/i);
  });

  it('does not create the output directory when it refuses to run', async () => {
    const ids = await idsFile('# nothing here\n');
    const parent = await tempDir('fetch-ids-parent-');
    const out = path.join(parent, 'never-created');

    await expect(fetchIds({ ids, out, fetchImpl: stubFetch({}), ...clock })).rejects.toThrow(/no template ids/i);
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });
});
