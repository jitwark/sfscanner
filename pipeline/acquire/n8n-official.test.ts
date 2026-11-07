import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireOfficial } from './n8n-official.js';
import { readWorkflowMap } from './official-store.js';

const testWorkDir = join(process.cwd(), 'pipeline', '.work', 'test-official');

beforeEach(async () => {
  await rm(testWorkDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(testWorkDir, { recursive: true, force: true });
});

describe('n8n-official acquisition', () => {
  it('acquires entries with link_only rights and no download property', async () => {
    const mockFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/search')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totalWorkflows: 1,
              workflows: [
                {
                  id: 101,
                  name: 'Webhook to Slack',
                  description: 'Sends webhook events to Slack.',
                  totalViews: 42,
                  createdAt: '2024-01-01T00:00:00.000Z',
                  user: { name: 'n8n', username: 'n8n-io', verified: true },
                  nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook' }],
                },
              ],
            }),
          } as Response;
        }
        if (url.includes('/workflows/101')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              workflow: {
                workflow: {
                  nodes: [
                    { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook' },
                    { id: '2', name: 'Slack', type: 'n8n-nodes-base.slack' },
                  ],
                  connections: {
                    Webhook: { main: [[{ node: 'Slack', type: 'main', index: 0 }]] },
                  },
                },
              },
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      },
    );

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 100,
      limit: 10,
    });

    expect(result.entries.length).toBe(1);
    const { entry, chart } = result.entries[0];
    expect(entry.rights.status).toBe('link_only');
    expect(entry.rights.licence).toBeNull();
    expect(entry.rights.reason).toBe('official n8n template - linked, not redistributed');
    expect(entry.download).toBeUndefined();
    expect(entry.structure.nodeCount).toBe(2);
    expect(entry.structure.connectionCount).toBe(1);
    expect(entry.structure.partial).toBeUndefined();
    expect(chart).toBeDefined();
    expect(chart.nodes.length).toBe(2);
    expect(chart.edges.length).toBe(1);
  });

  it('degrades gracefully with partial structure if detail fetch fails', async () => {
    const mockFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/search')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totalWorkflows: 1,
              workflows: [
                {
                  id: 102,
                  name: 'Scheduled report',
                  description: 'Creates a report on a schedule.',
                  nodes: [{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger' }],
                },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      },
    );

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 100,
      limit: 10,
    });

    expect(result.entries.length).toBe(1);
    const { entry, chart } = result.entries[0];
    expect(entry.structure.partial).toBe(true);
    expect(entry.structure.trigger).toBe('Schedule');
    expect(entry.rights.status).toBe('link_only');
    expect(entry.download).toBeUndefined();
    expect(chart).toBeDefined();
  });

  it('resumes from checkpoint page cursor', async () => {
    let pageCount = 0;
    const mockFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/search')) {
          pageCount += 1;
          const page = url.includes('page=2') ? 2 : 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totalWorkflows: 2,
              workflows: [
                {
                  id: page === 1 ? 201 : 202,
                  name: `Workflow ${page}`,
                  nodes: [{ name: 'Manual', type: 'n8n-nodes-base.manualTrigger' }],
                },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      },
    );

    const firstRun = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(firstRun.entries.length).toBe(1);
    expect(pageCount).toBe(1);

    const secondRun = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 2,
    });

    expect(secondRun.entries.length).toBe(2);
    expect(pageCount).toBe(2);
  });

  it('deduplicates repeated template IDs at a page boundary', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search?page=1')) {
        return { ok: true, status: 200, json: async () => ({ totalWorkflows: 2, workflows: [
          { id: 301, name: 'Repeated' }, { id: 301, name: 'Repeated' },
        ] }) } as Response;
      }
      if (url.includes('/search?page=2')) return { ok: true, status: 200, json: async () => ({ totalWorkflows: 2, workflows: [] }) } as Response;
      if (url.includes('/workflows/301')) return { ok: true, status: 200, json: async () => ({ workflow: { workflow: { nodes: [], connections: {} } } }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    const result = await acquireOfficial({ runId: 'test-official', workDir: testWorkDir, fetchImpl: mockFetch, sleep: async () => {}, rows: 2, limit: 2 });

    expect(result.entries).toHaveLength(1);
    expect(mockFetch.mock.calls.filter(([input]) => String(input).includes('/workflows/301'))).toHaveLength(1);
  });

  it('retries on 429 with backoff', async () => {
    let attempts = 0;
    const mockFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/search')) {
          attempts += 1;
          if (attempts === 1) {
            return { ok: false, status: 429, json: async () => ({}) } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              totalWorkflows: 1,
              workflows: [{ id: 301, name: 'Retry test', nodes: [] }],
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      },
    );

    let sleptMs = 0;
    const mockSleep = async (ms: number) => {
      sleptMs += ms;
    };

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: mockSleep,
      rows: 100,
      limit: 1,
    });

    expect(result.entries.length).toBe(1);
    expect(attempts).toBe(2);
    expect(sleptMs).toBeGreaterThan(0);
  });
});

describe('workflow body retention', () => {
  // Discarding the body is what made all 11,490 official templates hash
  // identically in `elect`, collapsing them to one canonical entry, and what
  // left every one of them ungraded. Retained for analysis only: rights stay
  // `link_only` and no body is ever published. See phase-7-official-json.md.
  it('writes the fetched workflow body to the append-only store', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalWorkflows: 1,
            workflows: [{ id: 601, name: 'Body kept', nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook' }] }],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow: {
            workflow: {
              nodes: [
                { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'hook' } },
                { id: '2', name: 'Slack', type: 'n8n-nodes-base.slack' },
              ],
              connections: { Webhook: { main: [[{ node: 'Slack', type: 'main', index: 0 }]] } },
            },
          },
        }),
      } as Response;
    });

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(result.workflowsPath).toBe(join(testWorkDir, 'official-workflows.jsonl'));
    expect(result.bodiesMissing).toBe(0);

    const stored = await readWorkflowMap(result.workflowsPath);
    expect(stored.size).toBe(1);
    const body = stored.get(601);
    expect((body?.nodes as unknown[]).length).toBe(2);
    // The parameters have to survive: the scanner reads them, and an entry
    // whose body arrives stripped grades clean for the wrong reason.
    expect(((body?.nodes as Record<string, unknown>[])[0] as { parameters: { path: string } }).parameters.path).toBe('hook');
  });

  it('counts a template whose body never arrived instead of storing an empty one', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalWorkflows: 1,
            workflows: [{ id: 602, name: 'No body', nodes: [{ name: 'Manual', type: 'n8n-nodes-base.manualTrigger' }] }],
          }),
        } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(result.bodiesMissing).toBe(1);
    const stored = await readWorkflowMap(result.workflowsPath);
    expect(stored.size).toBe(0);
    expect(result.entries[0].entry.structure.partial).toBe(true);
  });

  it.each([
    ['404 NotFoundError', 404],
    ['400 BadRequestError with message "Not found"', 400],
  ])('counts a template deleted upstream (%s) as gone, not as our failure', async (_label, status) => {
    // Measured against the live API on 2026-08-14: deleted templates answer
    // 404 on some ids and 400 on others. Only non-gone failures may abort a
    // build, so misfiling a 400 turns upstream housekeeping into a red run.
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalWorkflows: 1, workflows: [{ id: 604, name: 'Deleted upstream', nodes: [] }] }),
        } as Response;
      }
      return { ok: false, status, json: async () => ({}) } as Response;
    });

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(result.bodiesMissing).toBe(1);
    expect(result.bodiesGone).toBe(1);
  });

  it('counts a 500 as our failure, which is what may abort a build', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalWorkflows: 1, workflows: [{ id: 605, name: 'Server error', nodes: [] }] }),
        } as Response;
      }
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(result.bodiesMissing).toBe(1);
    expect(result.bodiesGone).toBe(0);
  });

  it('leaves dedup hashes empty for build-corpus to compute', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalWorkflows: 1, workflows: [{ id: 603, name: 'Hashes', nodes: [] }] }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow: { workflow: { nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.noOp' }], connections: {} } } }),
      } as Response;
    });

    const result = await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    const { entry } = result.entries[0];
    expect(entry.dedup.fingerprint).toBe('');
    expect(entry.dedup.structuralHash).toBe('');
    // `canonical: true` on arrival is a lie the acquirer is not entitled to tell.
    expect(entry.dedup.canonical).toBe(false);
    expect(entry.security.scannerVersion).toBe('unscanned');
  });
});

describe('checkpoint file naming', () => {
  it('does not checkpoint into entries.json, which build-corpus overwrites', async () => {
    // `build-corpus` writes the whole combined corpus to `entries.json` at the
    // end of a run. When this acquirer checkpointed to the same name, a
    // completed run left a file it would read back as its own partial progress,
    // so a re-run loaded every GitHub entry as an already-acquired official
    // template and appended pages on top of them.
    const mockFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalWorkflows: 1,
            workflows: [{ id: 501, name: 'Checkpoint probe', nodes: [], user: { name: 'n8n' } }],
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    await acquireOfficial({
      runId: 'test-official',
      workDir: testWorkDir,
      fetchImpl: mockFetch,
      sleep: async () => {},
      rows: 1,
      limit: 1,
    });

    expect(existsSync(join(testWorkDir, 'official-entries.json'))).toBe(true);
    expect(existsSync(join(testWorkDir, 'official-cursor.json'))).toBe(true);
    // The name build-corpus owns must be left alone.
    expect(existsSync(join(testWorkDir, 'entries.json'))).toBe(false);
  });
});
