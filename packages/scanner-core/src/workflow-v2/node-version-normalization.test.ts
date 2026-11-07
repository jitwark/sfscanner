import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from './normalize-security-workflow';

function versionOf(version: unknown): string | undefined {
  const bytes = new TextEncoder().encode(JSON.stringify({
    nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code',
      typeVersion: version, parameters: { language: 'python', pythonCode: 'exec(x)' } }],
    connections: {},
  }));
  const parsed = parseSourceDocument(bytes, DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return normalized.workflow.nodes[0]?.typeVersion;
}

describe('canonical admitted node versions', () => {
  it.each([2, '2', '2.0', '2.0.0'])('normalizes %s to 2.0.0', (value) => {
    expect(versionOf(value)).toBe('2.0.0');
  });
  it.each([1.2, '1.2', '1.2.0'])('normalizes %s to 1.2.0', (value) => {
    expect(versionOf(value)).toBe('1.2.0');
  });
  it('preserves existing numeric fractional-version normalization', () => {
    expect(versionOf(2.01)).toBe('2.01.0');
  });
  it.each(['2.0.0-alpha', '02', '2.01', 'bad', '2.0.0.0', ' 2'])('preserves unsupported %s', (value) => {
    expect(versionOf(value)).toBe(value);
  });
  it.each([null, true, -1])('does not invent a version for %s', (value) => {
    expect(versionOf(value)).toBeUndefined();
  });
});
