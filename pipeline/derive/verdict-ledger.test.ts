import { describe, expect, it } from 'vitest';
import type { Entry, EntrySecurity, PublicFinding } from '@hub/contracts';
import { makeEntry, makeSecurity } from '../__fixtures__/make-entry.js';
import { classifyRowState, compareVerdicts, type VerdictProjection } from './verdict-adjudication.js';
import { buildVerdictLedger } from './verdict-ledger.js';

const fpFinding: PublicFinding = {
  id: 'RAW_SECRET_INDICATOR',
  title: 'Credential-like value in node parameters',
  severity: 'MEDIUM',
  node: 'Todoist',
  why: 'A field that looks like a secret was found.',
  fix: 'Replace the value and use a credential.',
};

function projection(overrides: Partial<VerdictProjection> = {}): VerdictProjection {
  return {
    grade: 'MEDIUM',
    score: 40,
    counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
    findings: [fpFinding],
    hardenedExtra: 0,
    profile: 'beta-default',
    schemaVersion: 'scanner-result-v1',
    ...overrides,
  };
}

function rowEntry(id: string, security: EntrySecurity, analysis: 'derived' | 'unscanned'): Entry {
  return {
    ...makeEntry({ id, security }),
    readiness: {
      analysis,
      credentials: [],
      replaceableValues: [],
      writeActions: [],
      aiModel: { present: false, model: null },
      extraPackages: [],
      versionNotes: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
    },
  };
}

describe('row state', () => {
  it('reads a retained legacy stamp on an unscanned row as unscanned, not scanned', () => {
    // RED: the analytics contract counted a row as scanned whenever a
    // scannerVersion was present, so the no-body rows that carry the legacy
    // `c998701` stamp were reported as scanned. The readiness report is the
    // pipeline's own record that no body existed, and it has to win.
    const entry = rowEntry('e-unscanned-legacy-stamp', makeSecurity({ scannerVersion: 'c998701' }), 'unscanned');
    // The row really does carry a legacy stamp, so a stamp-first classifier would
    // answer `historical_verdict` and call it a verdict — the false-clean this
    // test exists to catch.
    expect(entry.security.scannerVersion).toBe('c998701');
    expect(classifyRowState(entry)).toBe('unscanned');
  });

  it('reads the acquirer no-body placeholders as unscanned whatever readiness claims', () => {
    expect(classifyRowState(rowEntry('e-not-scanned', makeSecurity({ scannerVersion: 'not-scanned' }), 'derived'))).toBe('unscanned');
    expect(classifyRowState(rowEntry('e-unscanned-stamp', makeSecurity({ scannerVersion: 'unscanned' }), 'derived'))).toBe('unscanned');
  });

  it('distinguishes a completed scan from a pre-contract verdict that carries only a stamp', () => {
    expect(classifyRowState(rowEntry('e-scanned', makeSecurity({ scannerVersion: 'scanner-beta-1', analysisStatus: 'COMPLETE' }), 'derived'))).toBe('scanned');
    expect(classifyRowState(rowEntry('e-historical', makeSecurity({ scannerVersion: 'c998701' }), 'derived'))).toBe('historical_verdict');
  });
});

describe('verdict comparison', () => {
  it('flags a verdict change and accepts a severity reduction', () => {
    const rescanned = projection({ grade: 'LOW', score: 10, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [] });
    const comparison = compareVerdicts(projection(), rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.changed.verdict).toBe(true);
    expect(comparison.changed.stamp).toBe(true);
    expect(comparison.changed.fields).toEqual(['grade', 'score', 'counts', 'findings']);
    expect(comparison.claim.class).toBe('false_positive_removed');
    expect(comparison.claim.grade).toBe('lowered');
    expect(comparison.claim.findingsRemoved).toBe(1);
    expect(comparison.disposition).toBe('accept-rescanned');
  });

  it('calls a purely different stamp not a verdict change', () => {
    const comparison = compareVerdicts(projection(), projection(), { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.changed.stamp).toBe(true);
    expect(comparison.changed.verdict).toBe(false);
    expect(comparison.changed.fields).toEqual([]);
    expect(comparison.claim.class).toBe('none');
    expect(comparison.disposition).toBe('accept-rescanned');
  });

  it('refuses to accept a change that adds a published finding', () => {
    const added: PublicFinding = { ...fpFinding, id: 'RAW_AUTH_HEADER', node: 'MySQL Pass', severity: 'HIGH' };
    const rescanned = projection({ grade: 'HIGH', score: 80, findings: [fpFinding, added] });
    const comparison = compareVerdicts(projection(), rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.claim.grade).toBe('raised');
    expect(comparison.disposition).toBe('requires-owner-decision');
  });

  it('refuses to read the loss of a genuine finding on the same rule as a false-positive removal', () => {
    // RED: `false_positive_removed` was chosen by arithmetic alone, so an engine
    // that stopped detecting raw secret material would have been auto-accepted as
    // a false-positive correction — a loss of detection sensitivity laundered as
    // an improvement. The record authorises exactly one removal: the MEDIUM
    // credential-plumbing `RAW_SECRET_INDICATOR`, never the HIGH raw-material class
    // of the same rule.
    const rawMaterial: PublicFinding = {
      ...fpFinding,
      title: 'Workflow parameters contain raw secret material',
      severity: 'HIGH',
      node: 'Virus total API TOKEN',
    };
    const stored = projection({ grade: 'HIGH', score: 80, counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, findings: [rawMaterial] });
    const rescanned = projection({ grade: 'LOW', score: 10, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [] });
    const comparison = compareVerdicts(stored, rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.claim.findingsRemoved).toBe(1);
    expect(comparison.claim.class).toBe('detection_loss');
    expect(comparison.disposition).toBe('requires-owner-decision');
    expect(comparison.rationale).toContain('detection_loss');
  });

  it('refuses to read the loss of another rule entirely as a false-positive removal', () => {
    const otherRule: PublicFinding = { ...fpFinding, id: 'RAW_AUTH_HEADER', node: 'MySQL Pass', severity: 'INFO' };
    const stored = projection({ grade: 'LOW', score: 10, counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 }, findings: [otherRule] });
    const rescanned = projection({ grade: 'LOW', score: 10, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [] });
    const comparison = compareVerdicts(stored, rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.claim.class).toBe('detection_loss');
    expect(comparison.disposition).toBe('requires-owner-decision');
  });

  it('counts one of two findings of a rule on one node as a removal', () => {
    // RED: findings were deduplicated on `${id}|${node}`, so dropping one of two
    // findings of the same rule on the same node left the key set unchanged and the
    // row was reported as no change at all.
    const stored = projection({ counts: { critical: 0, high: 0, medium: 2, low: 0, info: 0 }, findings: [fpFinding, fpFinding] });
    const rescanned = projection({ grade: 'LOW', score: 10, counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 }, findings: [fpFinding] });
    const comparison = compareVerdicts(stored, rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.changed.verdict).toBe(true);
    expect(comparison.changed.fields).toContain('findings');
    expect(comparison.claim.findingsRemoved).toBe(1);
    expect(comparison.claim.findingsAdded).toBe(0);
    // One occurrence of the recorded credential-plumbing class removed, one left.
    expect(comparison.claim.class).toBe('false_positive_removed');
  });

  it('does not read equal counts written in a different key order as a changed field', () => {
    // RED: the field comparison was a bare `JSON.stringify`, so two count objects
    // with equal values registered as changed on key order alone — a phantom
    // verdict change with no verdict behind it.
    const stored = projection({ counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 } });
    const rescanned = projection({ counts: { info: 0, low: 0, medium: 1, high: 0, critical: 0 } });
    const comparison = compareVerdicts(stored, rescanned, { stored: 'c998701', rescanned: 'scanner-beta-1' }, 'historical_verdict');
    expect(comparison.changed.fields).toEqual([]);
    expect(comparison.changed.verdict).toBe(false);
  });
});

describe('ledger derivation', () => {
  const storedUnchanged = makeSecurity({ scannerVersion: 'c998701', grade: 'LOW', score: 10 });
  const storedLowered = makeSecurity({ scannerVersion: 'c998701', grade: 'MEDIUM', score: 40, counts: { medium: 1 }, findings: [fpFinding] });
  const entries: Entry[] = [
    rowEntry('e-unchanged', storedUnchanged, 'derived'),
    rowEntry('e-lowered', storedLowered, 'derived'),
  ];
  const rescannedById: Record<string, EntrySecurity> = {
    'e-unchanged': makeSecurity({ scannerVersion: 'scanner-beta-1', grade: 'LOW', score: 10 }),
    'e-lowered': makeSecurity({ scannerVersion: 'scanner-beta-1', grade: 'LOW', score: 10 }),
  };

  const input = {
    entries,
    resolveBody: () => ({ body: { nodes: [] }, bodySha256: 'body-digest' }),
    scan: async (entry: Entry) => rescannedById[entry.id]!,
    scanner: { value: 'scanner-beta-1', kind: 'engine-identity' },
    recordedStamps: [
      { value: 'c998701', kind: 'git-commit-abbreviation' },
      { value: 'scanner-beta-1', kind: 'engine-identity' },
    ],
    derivedAt: '2026-09-25T00:00:00.000Z',
    corpus: { manifestSha256: 'manifest', totalEntries: 2, linkOnly: 0 },
    recordedRescan: null,
    superseded: null,
  };

  it('keys every redistributable row and separates a verdict change from a stamp change', async () => {
    const ledger = await buildVerdictLedger(input);
    expect(ledger.adjudication.rows).toBe(2);
    expect(ledger.adjudication.changed).toBe(1);
    expect(ledger.adjudication.stampOnly).toBe(1);
    expect(ledger.rows[0]?.key).toEqual({
      repo: 'owner/repo',
      commit: '1234567890123456789012345678901234567890',
      path: 'workflows/test.json',
      bodySha256: 'body-digest',
    });
    expect(ledger.rows.every((row) => row.old?.scanner.value === 'c998701')).toBe(true);
    expect(ledger.rows.every((row) => row.new?.scanner.value === 'scanner-beta-1')).toBe(true);
    // The stamp-only row publishes the same digest before and after.
    const unchanged = ledger.rows.find((row) => row.id === 'e-unchanged');
    expect(unchanged?.changed.verdict).toBe(false);
    expect(unchanged?.changed.stamp).toBe(true);
    expect(unchanged?.old?.resultDigest).toBe(unchanged?.new?.resultDigest);
  });

  it('is byte-stable across runs', async () => {
    const first = await buildVerdictLedger(input);
    const second = await buildVerdictLedger(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('marks a row with no committed body as retained historical rather than rescanning it', async () => {
    const ledger = await buildVerdictLedger({ ...input, resolveBody: () => null });
    expect(ledger.rows.every((row) => row.new === null)).toBe(true);
    expect(ledger.rows.every((row) => row.disposition === 'retain-historical')).toBe(true);
  });

  it('sends a row that loses a genuine finding to the owner instead of accepting it', async () => {
    // The disposition is what the acceptance decision reads, so the escalation has
    // to hold at the ledger level too: a row that shipped HIGH raw secret material
    // and comes back without it is not an accepted false-positive correction.
    const rawMaterial: PublicFinding = {
      ...fpFinding,
      title: 'Workflow parameters contain raw secret material',
      severity: 'HIGH',
      node: 'Virus total API TOKEN',
    };
    const genuine = rowEntry('e-detection-loss', makeSecurity({ scannerVersion: 'c998701', grade: 'HIGH', score: 80, counts: { high: 1 }, findings: [rawMaterial] }), 'derived');
    const ledger = await buildVerdictLedger({
      ...input,
      entries: [genuine],
      scan: async () => makeSecurity({ scannerVersion: 'scanner-beta-1', grade: 'LOW', score: 10 }),
    });
    const row = ledger.rows[0]!;
    expect(row.claim.class).toBe('detection_loss');
    expect(row.claim.findingsRemoved).toBe(1);
    expect(row.disposition).toBe('requires-owner-decision');
    expect(ledger.adjudication.byDisposition['requires-owner-decision']).toBe(1);
  });
});
