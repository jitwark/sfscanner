import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { buildEnrichmentIdentity } from './enrichment-identity.js';
import { runDescriptionBatches } from './batch-runner.js';
import { safeError, writeInputManifest } from './batch-runner-support.js';

const root = path.join(process.cwd(), 'pipeline', '.work', `batch-runner-${Date.now()}`);
const checkpointPath = path.join(root, 'checkpoint.json');
const ledgerPath = path.join(root, 'ledger.json');
const promptPath = path.join(root, 'prompt.txt');
const workflow = { nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }, { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} }], connections: {} };
const content = {
  headline: 'Send webhook updates to a Slack team channel',
  summary: 'This workflow receives a webhook event and sends a clear update to a Slack team channel for review.',
  outcome: Array(60).fill('The workflow explains how Slack receives webhook data for a team.').join(' '),
  beforeAfter: { before: 'A new event can be missed.', after: 'The event becomes a Slack message.' },
  exampleScenario: 'Example: imagine a form sends a request and Slack shows the team a message. This is a hypothetical example.',
  howItWorks: ['The webhook starts the workflow.', 'The workflow keeps the incoming fields.', 'Slack receives the message.'],
  limitations: ['The file does not include credentials or a final channel.'],
  audience: 'This is for a person learning how a small notification workflow works before importing it into n8n.',
};

function entry(id: string): Entry {
  return makeEntry({ id, description: '', descriptionSource: 'fallback' });
}

function output(input: Entry, promptText: string): Entry {
  const identity = buildEnrichmentIdentity(workflow, { promptText, promptVersion: 'prompt-v1', model: 'gemini-test' });
  return {
    ...input,
    summary: content.summary,
    description: content.outcome,
    descriptionSource: 'generated',
    descriptionContent: content,
    descriptionProvenance: { source: 'gemini', model: identity.model, promptVersion: identity.promptVersion, promptHash: identity.promptHash, schemaVersion: identity.schemaVersion, workflowHash: identity.workflowHash, generatedAt: '2026-08-17T00:00:00.000Z' },
  };
}

function writeCheckpoint(items: Entry[], promptText: string): void {
  const checkpointPathDir = path.dirname(checkpointPath);
  fs.mkdirSync(checkpointPathDir, { recursive: true });
  const checkpoint: Record<string, unknown> = fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>
    : {};
  for (const item of items) {
    const generated = output(item, promptText);
    const identity = buildEnrichmentIdentity(workflow, { promptText, promptVersion: 'prompt-v1', model: 'gemini-test' });
    checkpoint[item.id] = { summary: generated.summary, description: generated.description, descriptionSource: generated.descriptionSource, descriptionContent: generated.descriptionContent, descriptionProvenance: generated.descriptionProvenance, identity, workflowFingerprint: item.dedup.fingerprint };
  }
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint), 'utf8');
}

describe('runDescriptionBatches', () => {
  it('redacts secrets and URLs from durable error text', () => {
    expect(safeError('token=secret-value https://example.test/result')).toBe('token: [redacted] [url]');
  });

  it('completes and records every batch, then reuses verified batches without a model call', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(promptPath, 'prompt', 'utf8');
    const entries = [entry('one'), entry('two')];
    let calls = 0;
    const describeFn = async (batch: Entry[], options: { checkpointPath?: string }) => {
      calls++;
      writeCheckpoint(batch, 'prompt');
      return { entries: batch.map((item) => output(item, 'prompt')), rejections: [], stats: { total: batch.length, passedFirstTry: batch.length, neededRetry: 0, fellBack: 0, wallClockMs: 1, exampleDescriptions: [] } };
    };
    const options = { runId: 'test', entries, workflowsById: new Map(entries.map((item) => [item.id, workflow])), checkpointPath, ledgerPath, inputManifestPath: path.join(root, 'enrichment-input-manifest.json'), batchSize: 1, describeOptions: { systemPromptPath: promptPath, model: 'gemini-test', promptVersion: 'prompt-v1' }, describeFn };
    const first = await runDescriptionBatches(options);
    expect(first.completedBatches).toBe(2);
    expect(calls).toBe(2);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'enrichment-input-manifest.json'), 'utf8'));
    expect(manifest.entries).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain('nodes');
    const second = await runDescriptionBatches(options);
    expect(second.completedBatches).toBe(2);
    expect(calls).toBe(2);
  });

  it('verifies completed batches without invoking the model', async () => {
    const entries = [entry('one')];
    const options = {
      runId: 'verify-only', entries, workflowsById: new Map([[entries[0]!.id, workflow]]),
      checkpointPath, ledgerPath, batchSize: 1,
      describeOptions: { systemPromptPath: promptPath, model: 'gemini-test', promptVersion: 'prompt-v1' },
      describeFn: async () => { throw new Error('model must not be called'); },
    };
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(promptPath, 'prompt', 'utf8');
    writeCheckpoint(entries, 'prompt');
    const identity = buildEnrichmentIdentity(workflow, { promptText: 'prompt', promptVersion: 'prompt-v1', model: 'gemini-test' });
    const { recordBatchStart, recordBatchCompletion } = await import('./batch-ledger.js');
    recordBatchStart(ledgerPath, { batchIndex: 0, identityHash: 'placeholder', selectedCount: 1, selectedIds: ['one'] });
    const { createHash } = await import('node:crypto');
    const identityHash = createHash('sha256').update(JSON.stringify({ runId: 'verify-only', ids: ['one'], identities: [identity] })).digest('hex');
    const checkpointHash = createHash('sha256').update(JSON.stringify([['one', JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).one]])).digest('hex');
    recordBatchCompletion(ledgerPath, { batchIndex: 0, identityHash, checkpointHash, acceptedCount: 1 });
    const verified = await runDescriptionBatches({ ...options, verifyOnly: true });
    expect(verified.completedBatches).toBe(1);
  });

  it('keeps a prior input manifest when the same path receives a different selection', () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const entries = [entry('one'), entry('two')];
    const identities = new Map(entries.map((item) => [
      item.id,
      buildEnrichmentIdentity(workflow, { promptText: 'prompt', promptVersion: 'prompt-v1', model: 'gemini-test' }),
    ]));
    const fixedPath = path.join(root, 'immutable-manifest.json');
    const firstPath = writeInputManifest(fixedPath, { runId: 'test', entries: [entries[0]!], identities, batchSize: 1 });
    const secondPath = writeInputManifest(fixedPath, { runId: 'test', entries: [entries[1]!], identities, batchSize: 1 });
    expect(firstPath).toBe(fixedPath);
    expect(secondPath).not.toBe(fixedPath);
    expect(JSON.parse(fs.readFileSync(firstPath, 'utf8')).entries[0].id).toBe('one');
    expect(JSON.parse(fs.readFileSync(secondPath, 'utf8')).entries[0].id).toBe('two');
  });

  it('continues later batches when one item is rejected and records the rejection', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(promptPath, 'prompt', 'utf8');
    const entries = [entry('one'), entry('two'), entry('three')];
    let calls = 0;
    const describeFn = async (batch: Entry[]) => {
      calls++;
      if (batch[0]!.id === 'one') {
        return { entries: [{ ...batch[0]!, descriptionSource: 'fallback' as const, description: '' }], rejections: [{ id: 'one', reason: 'invalid' }], stats: { total: batch.length, passedFirstTry: 0, neededRetry: 0, fellBack: 0, wallClockMs: 1, exampleDescriptions: [] } };
      }
      writeCheckpoint(batch, 'prompt');
      return { entries: batch.map((item) => output(item, 'prompt')), rejections: [], stats: { total: batch.length, passedFirstTry: batch.length, neededRetry: 0, fellBack: 0, wallClockMs: 1, exampleDescriptions: [] } };
    };
    const result = await runDescriptionBatches({ runId: 'test', entries, workflowsById: new Map(entries.map((item) => [item.id, workflow])), checkpointPath, ledgerPath, batchSize: 1, describeOptions: { systemPromptPath: promptPath, model: 'gemini-test', promptVersion: 'prompt-v1' }, describeFn });
    expect(result.completedBatches).toBe(2);
    expect(result.rejectedBatches).toBe(1);
    expect(calls).toBe(3);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, { status: string; rejectedCount?: number; validationErrors?: string[] }>;
    expect(ledger['0']?.status).toBe('rejected');
    expect(ledger['0']?.rejectedCount).toBe(1);
    expect(ledger['0']?.validationErrors).toEqual(['one: invalid']);
    expect(ledger['1']?.status).toBe('completed');
    expect(ledger['2']?.status).toBe('completed');
  });
});
