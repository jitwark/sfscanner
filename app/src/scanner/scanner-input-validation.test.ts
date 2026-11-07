import { describe, expect, it } from 'vitest';
import { MAX_WORKFLOW_BYTES, exceedsWorkflowByteLimit } from './scanner-input-validation';

describe('exceedsWorkflowByteLimit', () => {
  it('rejects a long string without encoding it', () => {
    expect(exceedsWorkflowByteLimit('x'.repeat(MAX_WORKFLOW_BYTES + 1))).toBe(true);
  });

  it('accepts the exact byte boundary and rejects one byte over', () => {
    const exact = 'x'.repeat(MAX_WORKFLOW_BYTES);
    expect(exceedsWorkflowByteLimit(exact)).toBe(false);
    expect(exceedsWorkflowByteLimit(`${exact}y`)).toBe(true);
  });

  it('measures UTF-8 bytes, not code units', () => {
    // 1,536,000 is divisible by 3: 512,000 '界' are exactly 1,536,000 bytes.
    const atLimit = '界'.repeat(Math.ceil(MAX_WORKFLOW_BYTES / 3));
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_WORKFLOW_BYTES);
    expect(exceedsWorkflowByteLimit(atLimit)).toBe(false);

    // One more character is 1,536,003 bytes: over the limit while still under
    // it in code units, which is exactly the case a length-only check misses.
    const overLimit = '界'.repeat(Math.ceil(MAX_WORKFLOW_BYTES / 3) + 1);
    expect(overLimit.length).toBeLessThan(MAX_WORKFLOW_BYTES);
    expect(new TextEncoder().encode(overLimit).byteLength).toBeGreaterThan(MAX_WORKFLOW_BYTES);
    expect(exceedsWorkflowByteLimit(overLimit)).toBe(true);
  });
});
