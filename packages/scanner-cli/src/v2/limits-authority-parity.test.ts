import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { BUILTIN_LIMITS_AUTHORITY_V2 } from './contracts';

describe('CLI limits authority', () => {
  it('pins the digest the engine reports for the default limits', () => {
    const scanned = scanWorkflowV2({
      bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'),
      profile: { id: 'beta-default', version: '2.0.0' },
      limits: DEFAULT_SCANNER_LIMITS_V2,
    });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(BUILTIN_LIMITS_AUTHORITY_V2.digest).toBe(scanned.result.limits.digest);
  });
});
