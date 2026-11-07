import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { runHostedScan } from './worker-host';

const ENVELOPE_SCALAR_COUNT = 124_057;
const ENVELOPE_BYTES = 248_621;
const ENVELOPE_DEPTH = 255;

function envelopeBytes(): Uint8Array {
  const text = `${'['.repeat(ENVELOPE_DEPTH - 2)}[${'0,'.repeat(ENVELOPE_SCALAR_COUNT - 1)}0]${']'.repeat(ENVELOPE_DEPTH - 2)}`;
  if (text.length !== ENVELOPE_BYTES) throw new Error('Parser envelope dimensions drifted.');
  return new TextEncoder().encode(text);
}

describe('source work budget at the CLI host boundary', () => {
  it('returns the parser complexity failure inside the host deadline', async () => {
    const hosted = await runHostedScan(() => scanWorkflowV2({
      bytes: envelopeBytes(),
      profile: { id: 'beta-default', version: '2.0.0' },
    }), { timeoutMs: 5_000 });

    expect(hosted.status).toBe('COMPLETED');
    if (hosted.status !== 'COMPLETED') return;
    expect(hosted.value).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'SOURCE_WORK_LIMIT',
    });
  });
});