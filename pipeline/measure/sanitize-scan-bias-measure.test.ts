/**
 * AUDIT-SCAN-002 follow-up: `sanitize-scan-bias.ts` scores every candidate
 * through `scanCandidate` with no injected scanner, i.e. the worker path.
 * Before the fix, a malformed input (e.g. a Code node with a non-object
 * `parameters`) silently reparsed as `COMPLETE` on that path, so this
 * measurement's indeterminate counts understated how many inputs it
 * genuinely could not grade. These tests prove the counts are accurate now.
 */
import { describe, expect, it } from 'vitest';
import { measureSanitizeScanBias, type SanitizeScanBiasBody } from './sanitize-scan-bias-measure.js';

describe('measureSanitizeScanBias', () => {
  it('counts a malformed raw body as indeterminate instead of silently grading it', async () => {
    const malformed: SanitizeScanBiasBody = {
      templateId: 'malformed-1',
      workflow: {
        nodes: [{ id: '1', name: 'Code', type: 'n8n-nodes-base.code', parameters: 'not-object' }],
        connections: {},
      },
    };

    const report = await measureSanitizeScanBias([malformed]);

    expect(report.rawIndeterminate).toBe(1);
    expect(report.sanitizedIndeterminate).toBe(1);
    expect(report.rawGrades.UNKNOWN).toBe(1);
    expect(report.sanitizedGrades.UNKNOWN).toBe(1);
  });

  it('does not count a well-formed body as indeterminate', async () => {
    const wellFormed: SanitizeScanBiasBody = {
      templateId: 'ok-1',
      workflow: {
        nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
        connections: {},
      },
    };

    const report = await measureSanitizeScanBias([wellFormed]);

    expect(report.rawIndeterminate).toBe(0);
    expect(report.sanitizedIndeterminate).toBe(0);
  });

  it('mixes determinate and indeterminate bodies in the same sample without cross-contamination', async () => {
    const wellFormed: SanitizeScanBiasBody = {
      templateId: 'ok-2',
      workflow: {
        nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
        connections: {},
      },
    };
    const malformed: SanitizeScanBiasBody = {
      templateId: 'malformed-2',
      workflow: {
        nodes: [
          { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' },
          { id: '2', name: 'Code', type: 'n8n-nodes-base.code', parameters: 'not-object' },
        ],
        connections: {},
      },
    };

    const report = await measureSanitizeScanBias([wellFormed, malformed]);

    expect(report.sampled).toBe(2);
    expect(report.rawIndeterminate).toBe(1);
    expect(report.sanitizedIndeterminate).toBe(1);
  });
});
