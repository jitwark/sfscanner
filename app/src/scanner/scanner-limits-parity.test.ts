import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_BYTES, MAX_NODES } from './scan.worker';
import { MAX_WORKFLOW_BYTES } from './scanner-input-validation';

/**
 * P1.1 acceptance: one test enumerates every consumer of the shared scanner
 * limits and proves they read the same effective defaults. Each import below
 * is a real production module, not a stand-in — this fails the moment any of
 * them re-hardcodes its own number instead of reading `DEFAULT_SCANNER_LIMITS`.
 */
describe('scanner limits parity across every consumer', () => {
  it('the in-browser scan worker enforces the shared byte limit', () => {
    expect(MAX_BYTES).toBe(DEFAULT_SCANNER_LIMITS.maxBytes);
  });

  it('the in-browser scan worker enforces the shared node limit', () => {
    expect(MAX_NODES).toBe(DEFAULT_SCANNER_LIMITS.maxNodes);
  });

  it('the pre-upload file-size check uses the shared byte limit', () => {
    expect(MAX_WORKFLOW_BYTES).toBe(DEFAULT_SCANNER_LIMITS.maxBytes);
  });
});
