import { describe, expect, it } from 'vitest';
import { parseEntryArtifact, parseEntryArrayArtifact, parseEntryJson } from './entry-artifact';

const valid = {
  id: 'workflow-1', slug: 'workflow-1', title: 'Workflow', summary: 'A summary', description: 'A description', descriptionSource: 'upstream',
  source: { kind: 'github', repo: 'owner/repo', permalink: 'https://github.com/owner/repo/blob/abc/workflow.json', fetchedAt: '2026-01-01' },
  rights: { status: 'redistributable', licence: 'MIT', licenceUrl: 'https://spdx.org/licenses/MIT.html', reason: 'evidence' },
  structure: { nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, connectionCount: 0, nodeTypes: ['n8n-nodes-base.manualTrigger'], integrations: [], trigger: 'Manual', isSubWorkflow: false, complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false },
  security: { grade: 'LOW', score: 100, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0, scannerVersion: '1.0.0', profile: 'beta-default', schemaVersion: 'scanner-result-v1' },
  tags: ['automation'], dedup: { fingerprint: 'fp', structuralHash: 'sh', canonical: true, alsoFoundIn: [] },
};

describe('entry artifact contracts', () => {
  it('accepts a valid entry and shard, while omitting unknown fields', () => {
    const value = { ...valid, unknown: true };
    expect(parseEntryArtifact(value).id).toBe('workflow-1');
    expect(parseEntryArtifact(value)).not.toHaveProperty('unknown');
    expect(parseEntryArrayArtifact([value])).toHaveLength(1);
  });

  it('rejects malformed nested security, source, and duplicate-id data', () => {
    expect(() => parseEntryArtifact({ ...valid, security: { ...valid.security, score: 101 } })).toThrow(/security.score/);
    expect(() => parseEntryArtifact({ ...valid, source: { ...valid.source, kind: 'other' } })).toThrow(/source.kind/);
    expect(() => parseEntryArrayArtifact([valid, valid])).toThrow(/duplicate/);
  });

  it('carries the readiness derivation state, and rejects an unknown one', () => {
    const readiness = {
      analysis: 'unscanned',
      credentials: [],
      replaceableValues: [],
      writeActions: [],
      aiModel: { present: false, model: null },
      extraPackages: [],
      versionNotes: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
    };
    expect(parseEntryArtifact({ ...valid, readiness }).readiness?.analysis).toBe('unscanned');
    expect(() => parseEntryArtifact({ ...valid, readiness: { ...readiness, analysis: 'maybe' } }))
      .toThrow(/readiness\.analysis/);
    expect(parseEntryArtifact({ ...valid, readiness: { ...readiness, analysis: undefined } }).readiness?.analysis)
      .toBeUndefined();
  });

  it('retains release and audit source fields through JSON serialization', () => {
    const source = {
      ...valid.source,
      stars: 4200,
      path: 'workflows/deep/nested/example.json',
      commit: 'abc1234567890def',
    };
    const parsed = parseEntryArtifact({ ...valid, source });
    const roundTripped = parseEntryJson(JSON.stringify(parsed));

    expect(roundTripped.source).toMatchObject(source);
  });

  it('fails closed when an analysis status loses its required projection metadata', () => {
    expect(() => parseEntryArtifact({
      ...valid,
      security: { ...valid.security, analysisStatus: 'INDETERMINATE', grade: 'LOW' },
    })).toThrow(/indeterminate verdict/);
    expect(() => parseEntryArtifact({
      ...valid,
      security: { ...valid.security, analysisStatus: 'DEGRADED' },
    })).toThrow(/degraded diagnostics/);
    expect(() => parseEntryArtifact({
      ...valid,
      security: { ...valid.security, analysisStatus: 'COMPLETE', analysisDiagnosticCodes: ['SOURCE_SPAN_UNAVAILABLE'] },
    })).toThrow(/complete diagnostics/);
  });

  it('rejects scanned security without a result schema identity', () => {
    const { schemaVersion: _schemaVersion, ...security } = valid.security;
    expect(() => parseEntryArtifact({ ...valid, security })).toThrow(/security.schemaVersion/);
  });

  it('accepts legacy unscanned and indeterminate fallbacks without a schema identity', () => {
    const { schemaVersion: _schemaVersion, ...security } = valid.security;
    expect(parseEntryArtifact({ ...valid, security: { ...security, scannerVersion: 'not-scanned' } }).security.scannerVersion).toBe('not-scanned');
    expect(parseEntryArtifact({ ...valid, security: { ...security, scannerVersion: 'unknown', grade: 'UNKNOWN', score: 0, analysisStatus: 'INDETERMINATE' } }).security.analysisStatus).toBe('INDETERMINATE');
  });

  /**
   * The stamp reason is what separates "no body arrived" from "the body is here and
   * its upstream source is gone"; dropping it at the parse boundary would make the
   * published marker unreadable to every consumer downstream of this file.
   */
  it('carries the not-scanned stamp reason, and rejects one outside the vocabulary', () => {
    const security = { ...valid.security, scannerVersion: 'not-scanned', stampReason: 'source_unavailable' };
    expect(parseEntryArtifact({ ...valid, security }).security.stampReason).toBe('source_unavailable');
    expect(parseEntryArtifact({ ...valid, security: { ...valid.security, scannerVersion: 'not-scanned' } }).security.stampReason).toBeUndefined();
    expect(() => parseEntryArtifact({ ...valid, security: { ...security, stampReason: 'because' } }))
      .toThrow(/security\.stampReason/);
  });

  it('rejects invalid JSON before any detail consumer receives it', () => {
    expect(() => parseEntryJson('{"id":')).toThrow(/invalid JSON/i);
    expect(() => parseEntryJson(JSON.stringify({ ...valid, structure: { ...valid.structure, hasAI: 'yes' } }))).toThrow(/structure.hasAI/);
  });
});
