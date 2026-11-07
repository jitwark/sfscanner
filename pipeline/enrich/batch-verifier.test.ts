import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { buildEnrichmentIdentity, type EnrichmentIdentity } from './enrichment-identity.js';
import { verifyEnrichmentBatch } from './batch-verifier.js';

const workflow = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
    { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
  ],
  connections: {},
};

const content = {
  headline: 'Send webhook updates to a Slack team channel',
  summary: 'This workflow receives a webhook event and sends a clear update to a Slack team channel for review.',
  outcome: 'The workflow gives a team a simple way to turn an incoming event into a visible Slack update. It starts when the webhook receives data, keeps the values together while the workflow runs, and sends the useful result to the team channel. The JSON shows the order of the steps, but it does not prove which workspace or channel you will use after importing it.',
  beforeAfter: {
    before: 'A new event can sit unseen until somebody checks the source manually.',
    after: 'The same event becomes a Slack message that the team can read and act on.',
  },
  exampleScenario: 'Example: imagine a form sends a new request. The webhook receives it and the Slack node posts a short message so a team member can follow up. This is a hypothetical example based on the visible nodes, not a claim about a real workspace.',
  howItWorks: [
    'The webhook waits for a new event and starts the workflow when one arrives.',
    'The workflow keeps the incoming fields available for the next step.',
    'The Slack node formats the selected fields as a message for the team channel.',
  ],
  limitations: ['The file does not contain the credentials or the final Slack channel that you will choose during setup.'],
  audience: 'This is for a person who wants to understand a small notification workflow before importing it into n8n. Read the sections in order if you are new to automation. Start with the outcome, then compare the before and after view. Use the example only as a simple picture of the data path. The actual fields, channel names, and team rules still come from the workflow and your own setup. This explanation deliberately repeats the limits in plain language so a beginner can tell what the file shows, what the example imagines, and what must be configured after import. It does not promise that a message was sent, that a workspace exists, or that a person will respond. It only describes the visible webhook and Slack steps and the order in which they appear.',
};

function identityFor(id: string): EnrichmentIdentity {
  return buildEnrichmentIdentity(workflow, {
    promptText: 'prompt',
    promptVersion: 'prompt-v1',
    model: 'gemini-test',
  });
}

function generatedEntry(id = 'entry-1'): Entry {
  const entry = makeEntry({
    id,
    description: 'Generated description',
    descriptionSource: 'generated',
    descriptionContent: content,
    descriptionProvenance: {
      source: 'gemini',
      model: 'gemini-test',
      promptVersion: 'prompt-v1',
      promptHash: identityFor(id).promptHash,
      schemaVersion: identityFor(id).schemaVersion,
      workflowHash: identityFor(id).workflowHash,
      generatedAt: '2026-08-17T00:00:00.000Z',
    },
  });
  entry.descriptionProvenance = {
    source: 'gemini',
    model: 'gemini-test',
    promptVersion: 'prompt-v1',
    promptHash: identityFor(id).promptHash,
    schemaVersion: identityFor(id).schemaVersion,
    workflowHash: identityFor(id).workflowHash,
    generatedAt: '2026-08-17T00:00:00.000Z',
  };
  return entry;
}

describe('verifyEnrichmentBatch', () => {
  it('accepts a complete ordered generated batch', () => {
    const entry = generatedEntry();
    const result = verifyEnrichmentBatch({
      entries: [entry],
      results: [entry],
      identities: new Map([['entry-1', identityFor('entry-1')]]),
    });
    expect(result).toEqual({ ok: true, errors: [], accepted: ['entry-1'] });
  });

  it('uses retained workflow evidence when the entry structure omits a visible integration', () => {
    const driveWorkflow = {
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { name: 'Google Drive', type: 'n8n-nodes-base.googleDrive', parameters: {} },
      ],
      connections: {},
    };
    const driveContent = JSON.parse(JSON.stringify(content).replaceAll('Slack', 'Google Drive')) as typeof content;
    const identity = buildEnrichmentIdentity(driveWorkflow, { promptText: 'prompt', promptVersion: 'prompt-v1', model: 'gemini-test' });
    const entry = makeEntry({
      id: 'drive-entry',
      description: driveContent.outcome,
      descriptionSource: 'generated',
      descriptionContent: driveContent,
      structure: { nodeTypes: ['n8n-nodes-base.webhook'], integrations: ['webhook'] },
      descriptionProvenance: {
        source: 'gemini', model: identity.model, promptVersion: identity.promptVersion,
        promptHash: identity.promptHash, schemaVersion: identity.schemaVersion,
        workflowHash: identity.workflowHash, generatedAt: '2026-08-17T00:00:00.000Z',
      },
    });
    entry.descriptionProvenance = {
      source: 'gemini', model: identity.model, promptVersion: identity.promptVersion,
      promptHash: identity.promptHash, schemaVersion: identity.schemaVersion,
      workflowHash: identity.workflowHash, generatedAt: '2026-08-17T00:00:00.000Z',
    };
    const result = verifyEnrichmentBatch({
      entries: [entry], results: [entry], identities: new Map([['drive-entry', identity]]),
      workflowsById: new Map([['drive-entry', driveWorkflow]]),
    });
    expect(result).toEqual({ ok: true, errors: [], accepted: ['drive-entry'] });
  });

  it('rejects duplicate, fallback, and missing structured results', () => {
    const entry = generatedEntry();
    const fallback = makeEntry({ id: 'entry-2', descriptionSource: 'fallback' });
    const result = verifyEnrichmentBatch({
      entries: [entry, fallback],
      results: [entry, { ...fallback, id: 'entry-1' }],
      identities: new Map([['entry-1', identityFor('entry-1')], ['entry-2', identityFor('entry-2')]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['duplicate_id', 'fallback_output', 'missing_structured_content']));
  });

  it('rejects a batch with a missing result', () => {
    const entry = generatedEntry();
    const result = verifyEnrichmentBatch({
      entries: [entry],
      results: [],
      identities: new Map([['entry-1', identityFor('entry-1')]]),
    });
    expect(result.errors.map((error) => error.code)).toContain('missing_result');
  });

  it('rejects an output whose identity does not match the batch input', () => {
    const entry = generatedEntry();
    const wrongIdentity = { ...identityFor('entry-1'), workflowHash: 'wrong' };
    const result = verifyEnrichmentBatch({
      entries: [entry],
      results: [entry],
      identities: new Map([['entry-1', wrongIdentity]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain('identity_mismatch');
  });
});
