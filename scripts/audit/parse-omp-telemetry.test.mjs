import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTelemetry } from './parse-omp-telemetry.mjs';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(mainLines, advisorLines = null, files = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-synthetic-'));
  temporaryDirectories.push(directory);
  const mainJsonlPath = path.join(directory, 'main.jsonl');
  const advisorJsonlPath = path.join(directory, 'agents', '__advisor.jsonl');
  const folderPath = path.join(directory, 'agents');
  await fs.writeFile(mainJsonlPath, mainLines.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'));
  if (advisorLines !== null || Object.keys(files).length) await fs.mkdir(folderPath);
  if (advisorLines !== null) await fs.writeFile(advisorJsonlPath, advisorLines.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'));
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(folderPath, name), contents);
  return { mainJsonlPath, advisorJsonlPath, folderPath };
}

const assistant = content => ({ type: 'message', message: { role: 'assistant', content } });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });

describe('extractTelemetry synthetic files', () => {
  it('requires explicit session inputs instead of silently reading an old local session', async () => {
    await expect(extractTelemetry({ mainJsonlPath: '', advisorJsonlPath: '', folderPath: '' }))
      .rejects.toThrow('explicit');
  });
  it('continues after malformed and unknown JSONL and derives churn, errors and duration', async () => {
    const paths = await fixture([
      { type: 'session', id: 'synthetic', cwd: '/synthetic', title: 'synthetic', timestamp: '2026-01-01T00:00:00Z' },
      '{invalid', '', { type: 'unknown' },
      assistant([
        call('b1', 'bash', { command: ' echo synthetic ' }), call('b2', 'bash', { command: 'echo synthetic' }),
        call('b3', 'bash', { command: 'node --version' }),
        call('r1', 'read', { path: 'one.ts' }), call('r2', 'read', { path: 'one.ts' }), call('r3', 'read', { path: 'two.ts' }),
        call('e1', 'edit', { path: 'one.ts' }), call('e2', 'edit', { path: 'one.ts' }),
        call('w1', 'write', { path: 'new.ts' }), call('w2', 'write', { path: 'new.ts' }),
        { type: 'thinking', text: 'abcd' }, { type: 'text', text: 'xy' },
      ]),
      { type: 'message', message: { role: 'toolResult', toolName: 'edit', toolCallId: 'e1', isError: true } },
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', toolCallId: 'b1', isError: false } },
      { type: 'custom_message', customType: 'advisor', timestamp: '2026-01-01T02:00:00Z' },
    ]);
    const result = await extractTelemetry(paths);
    expect(result.session.durationHours).toBe(2);
    expect(result.tools).toMatchObject({ totalCalls: 10, totalResults: 2, totalErrors: 1, errorRatePct: 50 });
    expect(result.churn.bash).toEqual({ total: 3, unique: 2, repeatRatePct: 33.33, topCommands: [{ cmd: 'echo synthetic', count: 2 }, { cmd: 'node --version', count: 1 }] });
    expect(result.churn.reads).toEqual({ total: 3, unique: 2, repeatRatePct: 33.33, topFiles: [{ path: 'one.ts', count: 2 }, { path: 'two.ts', count: 1 }] });
    expect(result.churn.edits).toEqual({ total: 2, unique: 1, failedCount: 1, topFiles: [{ path: 'one.ts', count: 2 }] });
    expect(result.churn.writes).toEqual({ total: 2, unique: 1, topFiles: [{ path: 'new.ts', count: 2 }] });
    expect(result.tokensAndEfficiency.thinkingToTextRatioChars).toBe(2);
    expect(result.advisor.injectionsIntoMain).toBe(1);
    expect(result.subagents.totalUniqueSubagents).toBe(0);
  });

  it('recovers on the next advisor line after malformed JSON or malformed argument JSON', async () => {
    const result = await extractTelemetry(await fixture([], [
      '{invalid', assistant([{ type: 'toolCall', name: 'advise', arguments: '{invalid' }]),
      assistant([{ type: 'tool_call', function: { name: 'advise', arguments: '{"severity":"concern","note":"windows spawn"}' } }]),
    ]));
    expect(result.advisor.severityCounts.concern).toBe(1);
    expect(result.advisor.topics).toEqual({ windows_harness_and_spawning: 1 });
    expect(result.advisor.keyConcerns.map(entry => entry.note)).toEqual(['windows spawn']);
  });

  it('groups paired subagent files and assigns archetypes without counting the advisor', async () => {
    const result = await extractTelemetry(await fixture([], [], {
      'slice-writer.jsonl': '{}', 'slice-writer.md': 'synthetic',
      'slice-review.jsonl': '{}', 'audit-scout.md': 'synthetic', 'worker.md': 'synthetic', 'ignore.txt': 'synthetic',
    }));
    expect(result.subagents.totalUniqueSubagents).toBe(4);
    expect(result.subagents.archetypes).toEqual({ writers: 1, reviewers: 1, scouts: 1, others: 1 });
    expect(result.subagents.list.find(entry => entry.name === 'slice-writer')).toEqual({
      name: 'slice-writer', jsonlSize: 2, mdSize: 9, hasMd: true, hasJsonl: true, archetype: 'writer',
    });
    expect(result.subagents.list.some(entry => entry.name === '__advisor')).toBe(false);
  });
});
