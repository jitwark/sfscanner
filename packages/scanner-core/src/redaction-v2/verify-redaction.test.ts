import { describe, expect, it } from 'vitest';
import { createRedactionPatches, type RedactionPatchV2 } from './patches';
import { verifyRedactionResult } from './verify-redaction';

const source = { pointer: '/value', occurrencePath: [], astNodeId: 'c'.repeat(64), span: null } as const;

describe('redaction verification', () => {
  it('requires reparsing, rescanning, residual canaries, and idempotence', () => {
    const original = 'const token = "sk_live_12345678";';
    const created = createRedactionPatches({ text: original, candidates: [{ start: 15, end: 31, kind: 'CODE_LITERAL', source }], maxPatches: 1, maxArtifactBytes: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(verifyRedactionResult({ original, artifact: created.artifact.text, patches: created.patches, reparse: () => true, rescan: (text) => !text.includes('sk_live_12345678'), residual: (text) => !text.includes('sk_live_12345678') })).toEqual({ ok: true, reparsed: true, rescanned: true, idempotent: true, residualCanariesPassed: true });
    expect(verifyRedactionResult({ original, artifact: `${created.artifact.text}sk_live_12345678`, patches: created.patches })).toMatchObject({ ok: false, artifact: null, patches: [], error: { code: 'REDACTION_VERIFICATION_FAILED' } });
    expect(verifyRedactionResult({ original, artifact: created.artifact.text, patches: created.patches, reparse: () => false })).toMatchObject({ ok: false, artifact: null, patches: [] });
  });
  it('rejects token suffixes and encoded, hexadecimal, and PEM residual canaries', () => {
    const patch = (original: string): RedactionPatchV2 => ({ patchId: 'e'.repeat(64), source, region: { startUtf16Offset: 0, endUtf16Offset: original.startsWith('sk_live_12345678') ? 'sk_live_12345678'.length : original.indexOf(' ') }, component: 'SCALAR', classification: 'GENERIC_SECRET', certainty: 'VERIFIED_COMPONENT', replacement: '[REDACTED]' });
    for (const original of ['sk_live_12345678ABCDEFGHIJKL', 'secretvalue c2VjcmV0dmFsdWU=', 'secretvalue 73656372657476616c7565', 'privatekey -----BEGIN PRIVATE KEY-----']) {
      const patches = [patch(original)];
      const artifact = `[REDACTED]${original.slice(patches[0].region.endUtf16Offset)}`;
      expect(verifyRedactionResult({ original, artifact, patches })).toMatchObject({ ok: false, artifact: null, patches: [] });
    }
  });


  it('rejects patch tampering without returning source text', () => {
    const patch: RedactionPatchV2 = { patchId: 'd'.repeat(64), source, region: { startUtf16Offset: 0, endUtf16Offset: 3 }, component: 'SCALAR', classification: 'GENERIC_SECRET', certainty: 'VERIFIED_COMPONENT', replacement: '[REDACTED]' };
    const result = verifyRedactionResult({ original: 'abc', artifact: 'xyz', patches: [patch] });
    expect(result).toMatchObject({ ok: false, artifact: null, patches: [], error: { code: 'REDACTION_VERIFICATION_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('abc');
  });
});
