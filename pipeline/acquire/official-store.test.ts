import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendWorkflows,
  loadWorkflowIds,
  readWorkflowMap,
  workflowStorePath,
} from './official-store.js';

const dir = join(process.cwd(), 'pipeline', '.work', 'test-official-store');

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('official workflow store', () => {
  it('appends bodies and reads them back keyed by template id', async () => {
    const path = workflowStorePath(dir);
    await appendWorkflows(path, [
      { templateId: 1, workflow: { nodes: [{ name: 'A', type: 'n8n-nodes-base.webhook' }], connections: {} } },
      { templateId: 2, workflow: { nodes: [], connections: {} } },
    ]);
    await appendWorkflows(path, [{ templateId: 3, workflow: { nodes: [], connections: {} } }]);

    const map = await readWorkflowMap(path);
    expect(map.size).toBe(3);
    expect((map.get(1)?.nodes as unknown[])?.length).toBe(1);
    expect(map.has(3)).toBe(true);
  });

  it('escapes newlines inside a body so one record stays one line', async () => {
    const path = workflowStorePath(dir);
    await appendWorkflows(path, [
      { templateId: 7, workflow: { nodes: [{ name: 'multi\nline\nname' }], connections: {} } },
    ]);
    const map = await readWorkflowMap(path);
    expect(map.size).toBe(1);
    expect(((map.get(7)?.nodes as Record<string, unknown>[])[0] as { name: string }).name).toBe(
      'multi\nline\nname',
    );
  });

  it('lets the last record for a template id win, so a re-run repairs a torn page', async () => {
    const path = workflowStorePath(dir);
    await appendWorkflows(path, [{ templateId: 9, workflow: { nodes: [], connections: {} } }]);
    await appendWorkflows(path, [
      { templateId: 9, workflow: { nodes: [{ name: 'Repaired' }], connections: {} } },
    ]);

    const map = await readWorkflowMap(path);
    expect(map.size).toBe(1);
    expect((map.get(9)?.nodes as unknown[]).length).toBe(1);
  });

  it('skips a truncated trailing line rather than failing the whole load', async () => {
    // A kill during append can leave a partial final line. Everything before it
    // is still good, and losing 11,489 bodies to recover 1 is the wrong trade.
    const path = workflowStorePath(dir);
    await appendWorkflows(path, [{ templateId: 11, workflow: { nodes: [], connections: {} } }]);
    await writeFile(path, '{"templateId":12,"workflow":{"nod', { flag: 'a' });

    const map = await readWorkflowMap(path);
    expect(map.size).toBe(1);
    expect(map.has(11)).toBe(true);
  });

  it('reports stored ids without holding the bodies', async () => {
    const path = workflowStorePath(dir);
    await appendWorkflows(path, [
      { templateId: 21, workflow: { nodes: [], connections: {} } },
      { templateId: 22, workflow: { nodes: [], connections: {} } },
    ]);
    const ids = await loadWorkflowIds(path);
    expect([...ids].sort((a, b) => a - b)).toEqual([21, 22]);
  });

  it('returns an empty map when the store does not exist yet', async () => {
    const map = await readWorkflowMap(join(dir, 'missing.jsonl'));
    expect(map.size).toBe(0);
  });
});
