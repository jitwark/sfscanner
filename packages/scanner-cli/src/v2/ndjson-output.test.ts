import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { describe, expect, it } from 'vitest';
import type { BatchResultV2 } from './batch-runner';
import { DEFAULT_PROJECTION_OPTIONS } from './json-output';
import { serializeNdjsonV2 } from './ndjson-output';

function result(bytes = new TextEncoder().encode('{"nodes":[],"connections":{}}')) {
  const value = scanWorkflowV2({
    bytes,
    profile: { id: 'beta-default', version: '2.0.0' },
    limits: DEFAULT_SCANNER_LIMITS_V2,
  });
  if (!value.ok) throw new Error(value.code);
  return value.result;
}

type ParsedLine = {
  type: string;
  schemaVersion: string;
  exitReason?: string;
  item?: { readiness?: { completeness: { status: string }; prerequisites: { credentials: Array<{ credentialType: string }> } } };
};

function parseLines(text: string): ParsedLine[] {
  return text.trimEnd().split('\n').map((line) => JSON.parse(line) as ParsedLine);
}

describe('serializeNdjsonV2', () => {
  it('writes a deterministic header, one result per line, and a final summary', () => {
    const batch: BatchResultV2 = { ok: true, items: [
      { label: 'b.json', status: 'FAILED', error: { code: 'INVALID_JSON' } },
      { label: '日本語.json', status: 'COMPLETED', result: { ok: true, result: result() } },
    ], cancelled: false, completed: 1, failed: 1, concurrency: 2 };
    const first = serializeNdjsonV2(batch);
    expect(first).toBe(serializeNdjsonV2(batch));
    expect(first).not.toContain('\r');
    const lines = parseLines(first);
    expect(lines.map(({ type }) => type)).toEqual(['header', 'result', 'result', 'summary']);
    expect(lines.every(({ schemaVersion }) => schemaVersion === 'n8n-scan-v2-ndjson')).toBe(true);
  });

  it('keeps cancellation and empty batches structurally valid', () => {
    const cancelled: BatchResultV2 = { ok: true, items: [{ label: 'x.json', status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } }], cancelled: true, completed: 0, failed: 0, concurrency: 1 };
    const lines = parseLines(serializeNdjsonV2(cancelled));
    expect(lines.at(-1)).toMatchObject({ type: 'summary', exitReason: 'CANCELLED' });
    const empty = serializeNdjsonV2({ ok: true, items: [], cancelled: false, completed: 0, failed: 0, concurrency: 1 });
    expect(empty.trimEnd().split('\n')).toHaveLength(2);
  });

  it('omits readiness by default and attaches it only when the projection opts in', () => {
    const document = {
      name: 'Readiness workflow',
      nodes: [
        { id: 'notify', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 2, parameters: {}, credentials: { slackApi: { id: 'cred-1', name: 'Slack account' } } },
        { id: 'fetch', name: 'Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, parameters: {} },
      ],
      connections: {},
    };
    const source = new TextEncoder().encode(JSON.stringify(document));
    const batch: BatchResultV2 = {
      ok: true,
      items: [{ label: 'workflow.json', status: 'COMPLETED', result: { ok: true, result: result(source) }, rawWorkflow: document }],
      cancelled: false,
      completed: 1,
      failed: 0,
      concurrency: 1,
    };

    const projected = parseLines(serializeNdjsonV2(batch)).filter(({ type }) => type === 'result');
    expect(projected).toHaveLength(1);
    expect(projected[0]?.item?.readiness).toBeUndefined();

    const optedIn = parseLines(serializeNdjsonV2(batch, { ...DEFAULT_PROJECTION_OPTIONS, format: 'ndjson', includeReadiness: true }))
      .filter(({ type }) => type === 'result');
    expect(optedIn).toHaveLength(1);
    expect(optedIn[0]?.item?.readiness?.completeness.status).toBe('COMPLETE');
    expect(optedIn[0]?.item?.readiness?.prerequisites.credentials.map(({ credentialType }) => credentialType)).toEqual(['slackApi']);
  });
});
