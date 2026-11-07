import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { ChildProcess, spawn as spawnFnType } from 'node:child_process';
import { describeEntries } from './describe';
import { buildEnrichmentIdentity } from './enrichment-identity';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry';

type MockProcess = ChildProcess & {
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function makeMockEntry(id: string): Entry {
  return makeEntry({
    id,
    slug: id,
    title: `Workflow ${id}`,
    summary: '',
    description: '',
    descriptionSource: 'fallback',
    source: { kind: 'github', permalink: 'https://github.com', fetchedAt: '2026-01-01' },
    rights: { status: 'redistributable', licence: 'MIT', licenceUrl: null, reason: '' },
    structure: {
      nodeCount: 3,
      connectionCount: 2,
      nodeTypes: ['n8n-nodes-base.slack'],
      integrations: ['slack'],
      trigger: 'webhook',
      complexity: 'simple',
      hasCode: false,
      hasAI: false,
      hasWebhook: true,
    },
    security: {
      grade: 'LOW',
      score: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
      hardenedExtra: 0,
      scannerVersion: '1.0',
      profile: 'beta-default',
    },
    tags: ['slack'],
    dedup: { fingerprint: id, structuralHash: id, canonical: true, alsoFoundIn: [] },
  });
}

function workflowsFor(entries: Entry[]): ReadonlyMap<string, unknown> {
  return new Map(entries.map((entry) => [entry.id, {
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
    ],
    connections: {},
  }]));
}

function checkpointIdentity(id: string) {
  const workflow = workflowsFor([makeMockEntry(id)]).get(id);
  return buildEnrichmentIdentity(workflow, {
    promptText: fs.readFileSync(path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt'), 'utf8'),
    promptVersion: 'describe-6-json-workflow-lexical-check',
    model: 'google-antigravity/gemini-3.7-flash',
  });
}

function structuredDescription(id: string) {
  const detail = `This example explains entry ${id} in plain words. It is a teaching example, not a promise about data that is not shown in the workflow. Read the node names and the input fields before you import it. The file tells us that the webhook starts the run and that Slack receives the message. It does not tell us who owns the channel, what reply the team should send, or which local values you will need to replace. Those choices belong to your own setup. The page keeps those limits visible so a new reader can tell the difference between what the file shows and what a person might choose later. The reader can compare each step with the workflow file, check the fields they plan to use, and decide whether the visible path matches their own small task before importing anything.`;
  return {
    headline: 'Send incoming data to a Slack team note',
    summary: `This workflow receives a webhook event and sends the useful data to Slack for entry ${id}.`,
    outcome: `The webhook gives the workflow a clear starting point. It then moves the incoming fields to Slack so a team can read the note and choose what to do next. ${detail}`,
    beforeAfter: {
      before: 'New data arrives in an event and can be easy to miss when nobody is watching the source.',
      after: 'The workflow turns that event into a Slack message that puts the useful fields in front of the team.',
    },
    exampleScenario: `Example: imagine a form or another source sends one event. The webhook receives it, and Slack shows a note. ${detail}`,
    howItWorks: [
      'The webhook waits for a new event and starts the workflow when the event arrives.',
      'The workflow passes the fields from the event to the next step without adding facts that are not in the file.',
      'The Slack node turns the selected fields into a message for the team channel.',
      'The workflow ends after the message is ready for the team to read and follow up on.',
    ],
    limitations: [
      'The workflow file does not show who should read the channel or what they should do next.',
      'The example is hypothetical and does not claim that a real form, person, or channel exists.',
    ],
    audience: `This explanation is for a person who wants to understand entry ${id} before importing it. It uses common words and keeps the facts tied to the visible nodes.`,
  };
}

describe('describeEntries', () => {
  test('invokes spawn with exact argv, shell:false, 5-entry packet, and parses valid response', async () => {
    const entries = [1, 2, 3, 4, 5].map((i) => makeMockEntry(`entry-${i}`));
    const spawnedCalls: Array<{ exe: string; args: string[]; options: unknown }> = [];

    const mockSpawn = (exe: string, args: string[], options: unknown): ChildProcess => {
      spawnedCalls.push({ exe, args, options });
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;

      process.nextTick(() => {
        const packetArg = args[args.length - 1];
        const packetPath = path.resolve(process.cwd(), packetArg.slice(1));
        expect(fs.existsSync(packetPath)).toBe(true);

        const responseObj: unknown[] = [];
        for (const e of entries) {
          responseObj.push(structuredDescription(e.id));
        }

        proc.stdout.emit('data', Buffer.from(JSON.stringify(responseObj)));
        proc.emit('close', 0);
      });

      return proc;
    };

    const res = await describeEntries(entries, {
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      systemPromptPath: path.join(__dirname, 'describe-system.txt'),
      workflowsById: workflowsFor(entries),
    });

    expect(res.stats.total).toBe(5);
    expect(res.stats.passedFirstTry).toBe(5);
    expect(res.stats.fellBack).toBe(0);
    expect(spawnedCalls.length).toBe(1);
    expect(spawnedCalls[0].options).toMatchObject({ shell: false });
    expect(spawnedCalls[0].args[0]).toBe('-p');
    expect(spawnedCalls[0].args[1]).toBe('--no-session');
    expect(spawnedCalls[0].args[2]).toBe('--no-tools');
    expect(spawnedCalls[0].args[3]).toBe('--no-extensions');
    expect(spawnedCalls[0].args[4]).toBe('--model');
    expect(spawnedCalls[0].args[5]).toBe('google-antigravity/gemini-3.7-flash');
    expect(spawnedCalls[0].args[6]).toBe('--thinking');
    expect(spawnedCalls[0].args[7]).toBe('low');
    expect(spawnedCalls[0].args[8]).toBe('--system-prompt');
  });
  test('regenerates valid upstream prose only when explicitly requested', async () => {
    const entry = makeMockEntry('upstream');
    Object.assign(entry, { description: 'This upstream text is already present.', descriptionSource: 'upstream' as const });
    let spawnCalls = 0;
    const mockSpawn = (_exe: string, args: string[]): ChildProcess => {
      spawnCalls++;
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify([
          structuredDescription(entry.id),
        ])));
        proc.emit('close', 0);
      });
      return proc;
    };
    const checkpointPath = path.join(os.tmpdir(), `upstream-${Date.now()}.json`);
    await describeEntries([entry], {
      checkpointPath,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      workflowsById: workflowsFor([entry]),
    });
    expect(spawnCalls).toBe(0);
    const result = await describeEntries([entry], {
      checkpointPath,
      regenerateUpstream: true,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      workflowsById: workflowsFor([entry]),
    });
    expect(spawnCalls).toBe(1);
    expect(result.entries[0].descriptionSource).toBe('generated');
    fs.rmSync(checkpointPath, { force: true });
  });
  test('resumes from checkpoint file without re-calling spawn for completed entries', async () => {
    const tmpCheck = path.join(os.tmpdir(), `check-${Date.now()}.json`);
    const identity = checkpointIdentity('entry-1');
    const checkpointData = {
      'entry-1': {
        summary: 'Existing checkpoint summary for entry-1.',
        description: `Existing checkpoint description text for entry-1.

Paragraph two of description text.

Paragraph three of description text.`,
        descriptionSource: 'generated',
        descriptionContent: structuredDescription('entry-1'),
        descriptionProvenance: { source: 'gemini', model: identity.model, promptVersion: identity.promptVersion, promptHash: identity.promptHash, schemaVersion: identity.schemaVersion, workflowHash: identity.workflowHash, generatedAt: '2026-08-16T00:00:00.000Z' },
        workflowFingerprint: 'entry-1',
        identity,
      },
    };
    fs.writeFileSync(tmpCheck, JSON.stringify(checkpointData));

    const entries = [makeMockEntry('entry-1')];
    let spawnCalled = false;

    const mockSpawn = (): ChildProcess => {
      spawnCalled = true;
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    };

    const res = await describeEntries(entries, {
      checkpointPath: tmpCheck,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      workflowsById: workflowsFor(entries),
    });

    expect(res.stats.total).toBe(1);
    expect(res.entries[0].summary).toBe('Existing checkpoint summary for entry-1.');
    expect(spawnCalled).toBe(false);

    try {
      fs.unlinkSync(tmpCheck);
    } catch {}
  });

  test('resumes past checkpointed fallbacks instead of tripping the circuit breaker', async () => {
    // A run that fell back on some entries used to be unresumable: replaying the
    // cached fallbacks fed the rolling-window breaker and aborted before any work.
    const tmpCheck = path.join(os.tmpdir(), `check-fallback-${Date.now()}.json`);
    const cached = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `entry-${i}`,
        {
          summary: `Cached fallback summary for entry ${i}.`,
          description: 'Cached fallback description.\n\nSecond paragraph.\n\nThird paragraph.',
          descriptionSource: 'fallback',
          descriptionProvenance: { source: 'fallback', generatedAt: '2026-08-16T00:00:00.000Z' },
          workflowFingerprint: `entry-${i}`,
          identity: checkpointIdentity(`entry-${i}`),
        },
      ]),
    );
    fs.writeFileSync(tmpCheck, JSON.stringify(cached));

    const entries = Array.from({ length: 30 }, (_, i) => makeMockEntry(`entry-${i}`));
    let spawnCalled = false;
    const mockSpawn = (): ChildProcess => {
      spawnCalled = true;
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    };

    const res = await describeEntries(entries, {
      checkpointPath: tmpCheck,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      maxFallbackRate: 0.2,
      workflowsById: workflowsFor(entries),
    });

    expect(res.stats.total).toBe(30);
    expect(res.stats.fellBack).toBe(30);
    expect(spawnCalled).toBe(false);

    try {
      fs.unlinkSync(tmpCheck);
    } catch {}
  });

  test('retryFallbacks re-attempts cached fallbacks', async () => {
    const tmpCheck = path.join(os.tmpdir(), `check-retry-${Date.now()}.json`);
    fs.writeFileSync(
      tmpCheck,
      JSON.stringify({
        'entry-0': {
          summary: 'Cached fallback summary.',
          description: 'One.\n\nTwo.\n\nThree.',
          descriptionSource: 'fallback',
          descriptionProvenance: { source: 'fallback', generatedAt: '2026-08-16T00:00:00.000Z' },
          workflowFingerprint: 'entry-0',
          identity: checkpointIdentity('entry-0'),
        },
      }),
    );

    let spawnCalled = false;
    const mockSpawn = (): ChildProcess => {
      spawnCalled = true;
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => proc.emit('close', 1));
      return proc;
    };

    await describeEntries([makeMockEntry('entry-0')], {
      checkpointPath: tmpCheck,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      maxRetries: 0,
      retryFallbacks: true,
      workflowsById: workflowsFor([makeMockEntry('entry-0')]),
    });

    expect(spawnCalled).toBe(true);

    try {
      fs.unlinkSync(tmpCheck);
    } catch {}
  });

  test('keeps a retried fallback checkpointed when another concurrent retry aborts', async () => {
    const tmpCheck = path.join(os.tmpdir(), `check-concurrent-retry-${Date.now()}.json`);
    fs.writeFileSync(
      tmpCheck,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `entry-${index}`,
            {
              summary: 'Cached fallback summary.',
              description: 'One.\n\nTwo.\n\nThree.',
              descriptionSource: 'fallback',
              descriptionProvenance: { source: 'fallback', generatedAt: '2026-08-16T00:00:00.000Z' },
              workflowFingerprint: `entry-${index}`,
              identity: checkpointIdentity(`entry-${index}`),
            },
          ]),
        ),
      ),
    );

    let calls = 0;
    const mockSpawn = (_exe: string, args: string[]): ChildProcess => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      const call = calls++;
      process.nextTick(() => {
        if (call === 19) {
          proc.emit('close', 1);
          return;
        }
        const packet = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.at(-1)!.slice(1)), 'utf8')) as Array<{ id: string }>;
        const id = packet[0].id;
        proc.stdout.emit('data', Buffer.from(JSON.stringify([
          structuredDescription(id),
        ])));
        proc.emit('close', 0);
      });
      return proc;
    };

    await expect(
      describeEntries(Array.from({ length: 20 }, (_, index) => makeMockEntry(`entry-${index}`)), {
        checkpointPath: tmpCheck,
        spawnFn: mockSpawn as unknown as typeof spawnFnType,
        batchSize: 1,
        concurrency: 2,
        maxRetries: 0,
        maxFallbackRate: 0,
        retryFallbacks: true,
        workflowsById: workflowsFor(Array.from({ length: 20 }, (_, index) => makeMockEntry(`entry-${index}`))),
      }),
    ).rejects.toThrow(/Fallback rate/);

    const checkpoint = JSON.parse(fs.readFileSync(tmpCheck, 'utf8')) as Record<string, unknown>;
    expect(checkpoint).toHaveProperty('entry-19');

    try {
      fs.unlinkSync(tmpCheck);
    } catch {}
  });

  test('aborts when fallback rate exceeds threshold in rolling window', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => makeMockEntry(`fail-entry-${i}`));

    const mockSpawnAlwaysFail = (): ChildProcess => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => proc.emit('close', 1));
      return proc;
    };
    await expect(
      describeEntries(entries, {
        spawnFn: mockSpawnAlwaysFail as unknown as typeof spawnFnType,
        maxRetries: 0,
        fallbackWindowSize: 200,
        maxFallbackRate: 0.05,
        workflowsById: workflowsFor(entries),
      }),
    ).rejects.toThrow(/Refusal causes: .*Process exited with code 1/);
  });

  test('requireGemini records a rejection without emitting fallback prose', async () => {
    const entry = makeMockEntry('reject-me');
    const mockSpawn = (): ChildProcess => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      process.nextTick(() => proc.emit('close', 1));
      return proc;
    };
    const checkpointPath = path.join(os.tmpdir(), `require-gemini-${Date.now()}.json`);
    const result = await describeEntries([entry], {
      checkpointPath,
      spawnFn: mockSpawn as unknown as typeof spawnFnType,
      maxRetries: 0,
      requireGemini: true,
      workflowsById: workflowsFor([entry]),
    });
    expect(result.rejections[0]?.id).toBe('reject-me');
    expect(result.rejections[0]?.reason).toMatch(/^Gemini output remained invalid after retries: Process exited with code 1$/);
    expect(result.entries[0]?.description).toBe('');
    expect(result.entries[0]?.descriptionSource).toBe('fallback');
    expect(fs.existsSync(path.join(path.dirname(checkpointPath), 'enrichment-rejections.json'))).toBe(true);
    fs.rmSync(checkpointPath, { force: true });
    fs.rmSync(path.join(path.dirname(checkpointPath), 'enrichment-rejections.json'), { force: true });
  });
});
