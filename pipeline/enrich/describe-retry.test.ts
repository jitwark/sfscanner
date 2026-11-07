import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { ChildProcess, spawn as Spawn } from 'node:child_process';
import type { Entry } from '@hub/contracts';
import { describeEntries } from './describe';

type MockProcess = ChildProcess & { stdout: Readable; stderr: Readable; kill: () => boolean };

function entry(id: string): Entry {
  return {
    id, slug: id, title: id, summary: '', description: '', descriptionSource: 'fallback',
    source: { kind: 'github', permalink: 'https://example.test', fetchedAt: '2026-01-01' },
    rights: { status: 'redistributable', licence: 'MIT', licenceUrl: null, reason: '' },
    structure: { nodeCount: 2, connectionCount: 1, nodeTypes: ['n8n-nodes-base.slack'], integrations: ['slack'], trigger: 'webhook', complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: true },
    security: { grade: 'LOW', score: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0, scannerVersion: '1', profile: 'beta-default' },
    tags: ['slack'], dedup: { fingerprint: id, structuralHash: id, canonical: true, alsoFoundIn: [] },
  } as unknown as Entry;
}

function description(id: string) {
  const detail = `This plain explanation keeps the visible path tied to the workflow file for ${id}. It names the starting event, the fields that move forward, and the message handoff without inventing a person, account, channel, value, or result. A reader can compare each sentence with the nodes before importing the file. The file does not explain local credentials, final replies, or choices made by a team. Those limits remain visible so the reader can prepare the missing pieces in their own workspace.`;
  return {
    headline: 'Send a webhook message to Slack',
    summary: 'Receives a webhook event and sends its visible fields to Slack for a team to read.',
    outcome: `The workflow receives an event through a webhook and passes the visible fields to Slack as a team message. ${detail}`,
    beforeAfter: { before: 'An event arrives without a visible team handoff.', after: 'Slack receives a message built from the event fields.' },
    exampleScenario: `Example: imagine a form sends one event. The webhook receives it and Slack shows a note. ${detail}`,
    howItWorks: ['The webhook starts the flow when an event arrives.', 'The workflow passes the event fields to the next visible step.', 'The Slack node turns the selected fields into a message for a team to read.'],
    limitations: ['The file does not show the local account, channel choice, or reply process.'],
    audience: `This explanation is for a person who wants to understand ${id} before importing it.`,
  };
}

describe('describeEntries retry isolation', () => {
  test('retries each invalid workflow separately instead of repeating a failing mixed batch', async () => {
    const entries = [entry('retry-a'), entry('retry-b')];
    const packets: number[] = [];
    const prompts: string[] = [];
    let calls = 0;
    const spawn = (_exe: string, args: string[]): ChildProcess => {
      calls++;
      const promptArg = args[args.indexOf('--system-prompt') + 1];
      if (promptArg) prompts.push(fs.readFileSync(path.resolve(process.cwd(), promptArg), 'utf8'));
      const packet = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.at(-1)!.slice(1)), 'utf8')) as unknown[];
      packets.push(packet.length);
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => true;
      process.nextTick(() => {
        const values = calls === 1
          ? entries.map((item) => ({ ...description(item.id), exampleScenario: 'Example: imagine this takes seconds.' }))
          : [description(calls === 2 ? 'retry-a' : 'retry-b')];
        proc.stdout.emit('data', Buffer.from(JSON.stringify(values))); proc.emit('close', 0);
      });
      return proc;
    };
    const checkpointPath = path.join(os.tmpdir(), `describe-isolation-${Date.now()}.json`);
    const result = await describeEntries(entries, { checkpointPath, maxRetries: 1, spawnFn: spawn as unknown as typeof Spawn, workflowsById: new Map(entries.map((item) => [item.id, { nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook' }, { name: 'Slack', type: 'n8n-nodes-base.slack' }], connections: {} }])) });
    expect(result.rejections).toHaveLength(0); expect(packets).toEqual([2, 1, 1]);
    expect(prompts.slice(1).every((prompt) => prompt.includes('visible node label contains a token'))).toBe(true);
    fs.rmSync(checkpointPath, { force: true });
  });

  test('allows workflow-owned note text without treating it as injected catalogue prose', async () => {
    const item = entry('workflow-note');
    item.description = 'A long description that is part of the workflow sticky note and is allowed as workflow JSON.';
    const checkpointPath = path.join(os.tmpdir(), `describe-note-${Date.now()}.json`);
    const spawn = (_exe: string, _args: string[]): ChildProcess => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => true;
      process.nextTick(() => { proc.stdout.emit('data', Buffer.from(JSON.stringify([description(item.id)]))); proc.emit('close', 0); });
      return proc;
    };
    const result = await describeEntries([item], {
      checkpointPath,
      spawnFn: spawn as unknown as typeof Spawn,
      workflowsById: new Map([[item.id, { nodes: [{ name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: item.description } }, { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} }], connections: {} }]]),
      maxRetries: 0,
    });
    expect(result.rejections).toHaveLength(0);
    fs.rmSync(checkpointPath, { force: true });
  });
});
