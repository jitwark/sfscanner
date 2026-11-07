import { describe, expect, it } from 'vitest';
import { applyRedactionPatches, createRedactionPatches, type RedactionPatchV2 } from './patches';

const source = { pointer: '/nodes/0/value', occurrencePath: [0], astNodeId: 'a'.repeat(64), span: null } as const;
const candidate = (start: number, end: number, kind = 'TOKEN') => ({ start, end, kind, source });

describe('structural redaction patches', () => {
  it('does not classify benign scalar candidates as secrets', () => {
    const benignStrings = [
      'A workflow sends a status update after each run.',
      '{"retry": 3, "timeout": "30s", "enabled": true}',
      'OPENAI_API_KEY N8N_ENCRYPTION_KEY CLIENT_SECRET',
      '<your-password>',
      'This prose uses the word secret but contains no secret value.',
    ];
    for (const text of benignStrings) {
      const result = createRedactionPatches({
        text,
        candidates: [candidate(0, text.length, 'SCALAR')],
        maxPatches: 1,
        maxArtifactBytes: 1000,
      });
      expect(result).toMatchObject({ ok: false, artifact: null, patches: [], error: { code: 'REDACTION_PATCH_CONFLICT' } });
    }
  });

  it('creates deterministic patches and applies UTF-16 spans from right to left', () => {
    const text = '😀 sk_live_12345678 and ghpABCDEFGHIJKL';
    const first = text.indexOf('sk_live');
    const second = text.indexOf('ghp');
    const result = createRedactionPatches({
      text,
      candidates: [candidate(second, text.length, 'TOKEN'), candidate(first, first + 'sk_live_12345678'.length, 'CREDENTIAL')],
      maxPatches: 2,
      maxArtifactBytes: 100,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.text).toBe('😀 [REDACTED] and [REDACTED]');
      expect(result.patches.map((item) => item.region.startUtf16Offset)).toEqual([first, second]);
      expect(result.verification).toEqual({ reparsed: true, rescanned: true, idempotent: true, residualCanariesPassed: true });
      expect(createRedactionPatches({ text, candidates: [candidate(second, text.length, 'TOKEN'), candidate(first, first + 'sk_live_12345678'.length, 'CREDENTIAL')], maxPatches: 2, maxArtifactBytes: 100 })).toEqual(result);
    }
  });

  it('rejects overlap, unknown candidates, and patch/artifact max plus one without partial output', () => {
    const text = 'sk_live_12345678';
    for (const candidates of [[candidate(0, 6), candidate(4, 10)], [candidate(0, 6, 'UNKNOWN')]]) {
      const result = createRedactionPatches({ text, candidates, maxPatches: 3, maxArtifactBytes: 100 });
      expect(result).toMatchObject({ ok: false, artifact: null, patches: [], error: { code: 'REDACTION_PATCH_CONFLICT' } });
    }
    expect(createRedactionPatches({ text, candidates: [candidate(0, text.length)], maxPatches: 0, maxArtifactBytes: 100 })).toMatchObject({ ok: false, artifact: null, patches: [], error: { code: 'REDACTION_LIMIT_EXCEEDED' } });
    const bytes = new TextEncoder().encode('[REDACTED]').length;
    expect(createRedactionPatches({ text, candidates: [candidate(0, text.length)], maxPatches: 1, maxArtifactBytes: bytes - 1 })).toMatchObject({ ok: false, artifact: null, patches: [] });
    expect(createRedactionPatches({ text, candidates: [candidate(0, text.length)], maxPatches: 1, maxArtifactBytes: bytes })).toMatchObject({ ok: true });
  });

  it('never applies malformed or overlapping patches', () => {
    const patch = (start: number, end: number): RedactionPatchV2 => ({
      patchId: 'b'.repeat(64), source, region: { startUtf16Offset: start, endUtf16Offset: end }, component: 'SCALAR', classification: 'TOKEN', certainty: 'VERIFIED_COMPONENT', replacement: '[REDACTED]',
    });
    expect(applyRedactionPatches('abcdef', [patch(0, 4), patch(3, 6)])).toMatchObject({ ok: false, artifact: null, patches: [] });
    expect(applyRedactionPatches('abcdef', [patch(0, 4)])).toEqual({ ok: true, artifact: '[REDACTED]ef' });
  });
});
