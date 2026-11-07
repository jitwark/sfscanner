import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2 } from './scan-workflow';

const encoder = new TextEncoder();

describe('v2 source work usage', () => {
  it('reports the successful parser work count in the limits usage row', () => {
    const result = scanWorkflowV2({
      bytes: encoder.encode('{"nodes":[],"connections":{}}'),
      profile: { id: 'beta-default', version: '2.0.0' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const usage = result.result.limits.usage.find(({ id }) => id === 'maxSourceWork');
    expect(usage).toEqual({
      id: 'maxSourceWork',
      maximum: DEFAULT_SCANNER_LIMITS_V2.maxSourceWork,
      examined: 5,
      omitted: 0,
      exhausted: false,
    });
  });
});