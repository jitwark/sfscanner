import { describe, expect, it } from 'vitest';
import {
  admitManifest, compileManifest, manifestDigest,
  type BatchCandidate, type BatchReviewReceipt,
} from './admission-manifest';

const digest = (char: string) => char.repeat(64);
const record = (semanticId: string, nodeType: string, operation: string | null, version: string) => ({
  semanticId, nodeType, operation,
  versionRange: { clauses: [[{ op: 'EQ', version }]] },
});
const candidate = (key: string, value: unknown, resource: string | null = null): BatchCandidate => ({
  key, record: value, resource, evidenceDigest: digest('a'), fixtureDigest: digest('b'),
});
const reviewed = (manifestDigestValue: string, decision: 'APPROVED' | 'REJECTED' = 'APPROVED'): BatchReviewReceipt => ({
  schemaVersion: '1', manifestDigest: manifestDigestValue, reviewer: 'batch-reviewer',
  reviewedAt: '2026-10-22T00:00:00.000Z', decision, evidenceArtifactDigest: digest('c'),
});

describe('admission manifest compiler', () => {
  it('compiles a deterministic unsigned manifest and stable record digests', () => {
    const input = {
      templateDigest: digest('d'), sourceReceiptDigests: [digest('e'), digest('f'), digest('e')],
      candidates: [candidate('note', record('note', 'base.note', null, '1.0.0')), candidate('gmail.send', record('gmail.send', 'base.gmail', 'send', '2.2.0'), 'message')],
    };
    const compiled = compileManifest(input);
    expect(compiled.manifest.records.map(({ key }) => key)).toEqual(['gmail.send', 'note']);
    expect(compiled.manifest.sourceReceiptDigests).toEqual([digest('e'), digest('f')]);
    expect(compiled.manifest.candidateSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest(compiled.manifest)).toBe(manifestDigest(compiled.manifest));
    expect(compileManifest(input).manifest).toEqual(compiled.manifest);
  });

  it('rejects duplicate keys and overlapping same-resource scopes', () => {
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', record('a', 'n', null, '1.0.0')), candidate('a', record('b', 'n', null, '2.0.0'))] })).toThrow(/Duplicate candidate key/);
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', record('a', 'n', 'send', '2.2.0')), candidate('b', record('b', 'n', 'send', '2.2.0'))] })).toThrow(/Overlapping candidate scopes/);
  });

  it('allows two resources to share the same operation name', () => {
    const compiled = compileManifest({
      templateDigest: digest('d'), sourceReceiptDigests: [],
      candidates: [candidate('gmail', record('a', 'n', 'send', '2.2.0'), 'message'), candidate('slack', record('b', 'n', 'send', '2.2.0'), 'channel')],
    });
    expect(compiled.manifest.records).toHaveLength(2);
  });

  it('checks every OR-clause interval and rejects dynamic resources', () => {
    const orRange = { semanticId: 'a', nodeType: 'n', operation: 'send', versionRange: { clauses: [[{ op: 'EQ', version: '1.0.0' }], [{ op: 'EQ', version: '3.0.0' }]] } };
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', orRange), candidate('b', record('b', 'n', 'send', '1.0.0'))] })).toThrow(/Overlapping candidate scopes/);
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', orRange), candidate('b', record('b', 'n', 'send', '2.0.0'))] })).not.toThrow();
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', record('a', 'n', 'send', '1.0.0'), '={{ $json.resource }}')] })).toThrow(/resource/);
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', record('a', 'n', '={{ $json.operation }}', '1.0.0'))] })).toThrow(/operation/);
  });

  it('rejects wildcard operation claims', () => {
    expect(() => compileManifest({ templateDigest: digest('d'), sourceReceiptDigests: [], candidates: [candidate('a', record('a', 'n', '*', '1.0.0'))] })).toThrow(/wildcard/);
  });
});

describe('detached batch admission', () => {
  const compile = () => compileManifest({
    templateDigest: digest('d'), sourceReceiptDigests: [digest('e')],
    candidates: [candidate('note', record('note', 'base.note', null, '1.0.0')), candidate('gmail.send', record('gmail.send', 'base.gmail', 'send', '2.2.0'), 'message')],
  });
  const approved = (compiled: ReturnType<typeof compile>) => {
    const manifest = compiled.manifest;
    return { ...reviewed(manifestDigest(manifest)), evidenceArtifactDigest: manifest.candidateSetDigest };
  };

  it('admits every reviewed record only with an APPROVED matching receipt', () => {
    const compiled = compile();
    const result = admitManifest(compiled.manifest, approved(compiled), compiled.candidates, ['batch-reviewer']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipts.map(({ key }) => key)).toEqual(['gmail.send', 'note']);
  });

  it.each([
    ['rejected receipt', (compiled: ReturnType<typeof compile>) => ({ ...approved(compiled), decision: 'REJECTED' as const })],
    ['wrong manifest digest', (compiled: ReturnType<typeof compile>) => ({ ...approved(compiled), manifestDigest: digest('0') })],
    ['wrong evidence artifact', (compiled: ReturnType<typeof compile>) => ({ ...approved(compiled), evidenceArtifactDigest: digest('0') })],
  ])('refuses %s', (_label, receiptOf) => {
    const compiled = compile();
    expect(admitManifest(compiled.manifest, receiptOf(compiled), compiled.candidates, ['batch-reviewer'])).toMatchObject({ ok: false });
  });

  it('refuses an unauthorized reviewer and a malformed review timestamp', () => {
    const compiled = compile();
    const receipt = approved(compiled);
    expect(admitManifest(compiled.manifest, receipt, compiled.candidates, ['someone-else'])).toMatchObject({ ok: false, reason: 'UNAUTHORIZED_REVIEWER' });
    expect(admitManifest(compiled.manifest, { ...receipt, reviewedAt: 'yesterday' }, compiled.candidates, ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'INVALID_REVIEWED_AT' });
  });

  it('refuses mutated records, changed fixtures, unreviewed and extra candidates', () => {
    const compiled = compile();
    const receipt = approved(compiled);
    const mutated = compiled.candidates.map((item) => item.key === 'note' ? { ...item, record: { ...(item.record as object), extra: true } } : item);
    expect(admitManifest(compiled.manifest, receipt, mutated, ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'MUTATED_RECORD' });
    const changedFixture = compiled.candidates.map((item) => item.key === 'note' ? { ...item, fixtureDigest: digest('9') } : item);
    expect(admitManifest(compiled.manifest, receipt, changedFixture, ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'FIXTURE_MISMATCH' });
    const changedScope = compiled.candidates.map((item) => item.key === 'gmail.send' ? { ...item, resource: 'label' } : item);
    expect(admitManifest(compiled.manifest, receipt, changedScope, ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'MUTATED_RECORD' });
    expect(admitManifest(compiled.manifest, receipt, compiled.candidates.slice(1), ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'UNREVIEWED_KEY' });
    expect(admitManifest(compiled.manifest, receipt, [...compiled.candidates, candidate('extra', record('x', 'x', null, '1.0.0'))], ['batch-reviewer'])).toMatchObject({ ok: false, reason: 'UNREVIEWED_KEY' });
  });
});
