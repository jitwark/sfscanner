import { describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { invokeOmp } from './describe-spawn';

describe('invokeOmp', () => {
  test('uses the configured Antigravity proxy instead of spawning OMP', async () => {
    let called = false;
    const fetchFn: typeof fetch = async (_input, init) => {
      called = true;
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer proxy-key' });
      return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 });
    };

    const result = await invokeOmp([{ nodes: [], connections: {} }], {
      systemPromptPath: path.join(process.cwd(), 'pipeline/enrich/describe-system.txt'),
      proxyBaseUrl: 'http://127.0.0.1:8045/v1',
      proxyApiKey: 'proxy-key',
      proxyModel: 'gemini-3.7-flash-low',
      fetchFn,
      spawnFn: (() => { throw new Error('OMP must not be spawned when proxy is configured'); }) as never,
    });

    expect(called).toBe(true);
    expect(result).toEqual({ ok: true, data: [] });
  });

  test('retries a provider policy refusal with a restricted workflow-only projection', async () => {
    const requests: any[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (requests.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'The prompt could not be submitted because of the Generative AI Prohibited Use policy.' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 });
    };

    const result = await invokeOmp([{
      nodes: [{ name: 'Analyze Video', type: 'n8n-nodes-base.httpRequest', parameters: { jsonBody: 'free-form prompt text' } }, { name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'setup prose' } }],
      connections: {},
    }], {
      systemPromptPath: path.join(process.cwd(), 'pipeline/enrich/describe-system.txt'),
      proxyBaseUrl: 'http://127.0.0.1:8045/v1', proxyApiKey: 'proxy-key', proxyModel: 'gemini-3.7-flash-low', fetchFn,
    });

    expect(result).toEqual({ ok: true, data: [] });
    expect(requests).toHaveLength(2);
    const restricted = JSON.parse(requests[1].messages[1].content)[0];
    expect(restricted.nodes).toEqual([
      { name: 'Analyze Video', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      { name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', parameters: {} },
    ]);
  });

  test('adds a revision hint to a temporary system prompt without changing the model JSON packet', async () => {
    const workflows = [{ nodes: [{ name: 'Wait', type: 'n8n-nodes-base.wait', parameters: {} }], connections: {} }];
    let promptText = '';

    const spawnFn = (_exe: string, args: string[]): ChildProcess => {
      const proc = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => {
        const promptArg = args[args.indexOf('--system-prompt') + 1]!;
        promptText = fs.readFileSync(path.resolve(process.cwd(), promptArg), 'utf8');
        proc.stdout.emit('data', Buffer.from('[]'));
        proc.emit('close', 0);
      });
      return proc;
    };

    const result = await invokeOmp(workflows, {
      systemPromptPath: path.join(process.cwd(), 'pipeline/enrich/describe-system.txt'),
      promptHint: 'Revision hint: remove every forbidden timing word before returning JSON.',
      spawnFn: spawnFn as never,
    });

    expect(result.ok).toBe(true);
    expect(promptText).toContain('Revision hint: remove every forbidden timing word before returning JSON.');
  });

  test('writes only the ordered model-safe workflow JSON array to the packet file', async () => {
    const workflows = [
      { name: 'Website title', description: 'Website prose must not be sent.', nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }], connections: {} },
      { nodes: [{ name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} }], connections: {} },
    ];
    let packet: unknown;
    let packetPath: string | undefined;

    const spawnFn = (_exe: string, args: string[]): ChildProcess => {
      const proc = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => {
        const packetArg = args.at(-1)!;
        packetPath = path.resolve(process.cwd(), packetArg.slice(1));
        packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
        proc.stdout.emit('data', Buffer.from(JSON.stringify([
          {
            headline: 'A workflow headline', summary: 'This workflow receives an event and sends a Slack note for a team to read.',
            outcome: 'The workflow moves the event into a message. This is a plain explanation of the result. It does not claim facts that are not in the file. A reader can use it to see the path from the start node to the last node. The page keeps the limits clear so a new user can decide what to check next. The text is long enough to prove that structured output can carry a useful explanation without using website prose or hidden metadata. It names the visible steps and leaves unknown choices open. That makes the example useful for a test and for a person who needs context before import.',
            beforeAfter: { before: 'An event arrives and can be missed.', after: 'A Slack note puts the event in front of the team.' },
            exampleScenario: 'Example: imagine a new event arrives at the webhook and Slack shows a note for the team. This is only a teaching example.',
            howItWorks: ['The webhook waits for a new event and starts the run.', 'The workflow passes the event fields to the next step.', 'The Slack node turns the fields into a team note.'],
            limitations: ['The file does not show who replies to the note or which local values they choose.'],
            audience: 'This is for a person who wants a plain view of the event path before importing it.',
          },
          {
            headline: 'Another workflow headline', summary: 'This workflow receives an event and sends a Slack note for another team to read.',
            outcome: 'The workflow moves the event into a message. This is a plain explanation of the result. It does not claim facts that are not in the file. A reader can use it to see the path from the start node to the last node. The page keeps the limits clear so a new user can decide what to check next. The text is long enough to prove that structured output can carry a useful explanation without using website prose or hidden metadata. It names the visible steps and leaves unknown choices open. That makes the example useful for a test and for a person who needs context before import.',
            beforeAfter: { before: 'An event arrives and can be missed.', after: 'A Slack note puts the event in front of the team.' },
            exampleScenario: 'Example: imagine a new event arrives at the webhook and Slack shows a note for the team. This is only a teaching example.',
            howItWorks: ['The webhook waits for a new event and starts the run.', 'The workflow passes the event fields to the next step.', 'The Slack node turns the fields into a team note.'],
            limitations: ['The file does not show who replies to the note or which local values they choose.'],
            audience: 'This is for a person who wants a plain view of the event path before importing it.',
          },
        ])));
        proc.emit('close', 0);
      });
      return proc;
    };

    const result = await invokeOmp(workflows, {
      systemPromptPath: path.join(process.cwd(), 'pipeline/enrich/describe-system.txt'),
      spawnFn: spawnFn as never,
    });

    expect(result.ok).toBe(true);
    expect(packet).toEqual([
      { nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }], connections: {} },
      { nodes: [{ name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} }], connections: {} },
    ]);
    expect(packetPath).toBeDefined();
    expect(fs.existsSync(packetPath!)).toBe(false);
    if (result.ok) expect(result.data).toHaveLength(2);
  });

  test('uses injected deterministic inputs for temporary prompt and packet names', async () => {
    let defaultNow = 10;
    let defaultRandom = 0.1;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => defaultNow++);
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => (defaultRandom += 0.1));
    const nowFn = vi.fn(() => 1234);
    const randomFn = vi.fn(() => 0.5);
    const tempNames: Array<{ prompt: string; packet: string }> = [];
    const spawnFn = (_exe: string, args: string[]): ChildProcess => {
      const proc = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      tempNames.push({
        prompt: path.basename(args[args.indexOf('--system-prompt') + 1]!),
        packet: path.basename(args.at(-1)!.slice(1)),
      });
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('[]'));
        proc.emit('close', 0);
      });
      return proc;
    };

    try {
      const options = {
        systemPromptPath: path.join(process.cwd(), 'pipeline/enrich/describe-system.txt'),
        promptHint: 'Keep the deterministic fixture stable.',
        nowFn,
        randomFn,
        spawnFn: spawnFn as never,
      };
      await invokeOmp([{ nodes: [], connections: {} }], options);
      await invokeOmp([{ nodes: [], connections: {} }], options);
      const productionOptions = { ...options, nowFn: undefined, randomFn: undefined };
      await invokeOmp([{ nodes: [], connections: {} }], productionOptions);
      await invokeOmp([{ nodes: [], connections: {} }], productionOptions);

      expect(nowFn).toHaveBeenCalledTimes(4);
      expect(randomFn).toHaveBeenCalledTimes(4);
      expect(tempNames[0]).toEqual(tempNames[1]);
      expect(tempNames[2]).not.toEqual(tempNames[3]);
      expect(tempNames[0]?.prompt).toMatch(/^prompt-/u);
      expect(tempNames[0]?.packet).toMatch(/^packet-/u);
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});
