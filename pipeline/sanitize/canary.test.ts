import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeWorkflow } from './redact.js';
import { verifySanitizedWorkflow } from './verify.js';

describe('Canary test', () => {
  it('sanitizes and verifies canary fixture with zero canary strings surviving anywhere', async () => {
    const fixturePath = join(import.meta.dirname, '__fixtures__', 'canary-workflow.json');
    const rawContent = await readFile(fixturePath, 'utf-8');
    const originalJson = JSON.parse(rawContent);

    const canarySubstrings = [
      'canaryFakeSecretKey',
      'canarySignature',
      'canaryUser',
      'canaryPass',
      'sk-proj-canary',
    ];

    const sanitizeResult = sanitizeWorkflow(originalJson);
    expect(sanitizeResult.ok).toBe(true);

    const verifyResult = verifySanitizedWorkflow(originalJson, sanitizeResult.workflow);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.errors).toHaveLength(0);

    const workflowStr = JSON.stringify(sanitizeResult.workflow);
    const manifestStr = JSON.stringify(sanitizeResult.manifest);

    for (const canary of canarySubstrings) {
      expect(workflowStr.includes(canary)).toBe(false);
      expect(manifestStr.includes(canary)).toBe(false);
    }

    // Verify manifest entries exist for all 3 canary items
    expect(sanitizeResult.manifest.length).toBeGreaterThanOrEqual(3);
  });
});
