import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportEvidence } from './report-evidence';

const digest = 'b'.repeat(64);
const span = { start: { line: 3, column: 5, utf16Offset: 10, utf8ByteOffset: 10 }, end: { line: 3, column: 15, utf16Offset: 20, utf8ByteOffset: 20 } };
const source = { kind: 'SOURCE', source: { pointer: '/nodes/0/parameters', occurrencePath: [], astNodeId: digest, span } };

function model(overrides: Record<string, unknown> = {}): ScannerReportModelV2 {
  return {
    v2: {
      schemaVersion: 'scanner-result-v2',
      analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
      facts: [],
      findings: [],
      ...overrides,
    },
  } as unknown as ScannerReportModelV2;
}

function fact(kind: string, properties: Record<string, unknown>, subject: unknown = source) {
  return { factId: digest, kind, subject, properties };
}

const finding = {
  findingId: digest, ruleId: 'RAW_SECRET_INDICATOR', ruleRevision: '1', effect: 'REPORT_ONLY',
  severity: 'HIGH', confidence: 'MEDIUM', evidenceClass: 'CONFIGURATION', conclusion: 'OBSERVED',
  applicability: 'APPLICABLE', subject: source, factRefs: [digest], traceRefs: [], remediationId: 'review',
};

describe('ReportEvidence', () => {
  afterEach(cleanup);

  it('shows evidence metadata, source spans, fact kinds, and allowlisted fact fields without payload text', () => {
    render(<ReportEvidence model={model({
      facts: [fact('node.configuration.v2', { observation: 'SECRET_INDICATOR', member: 'sk_live_12345678' })],
      findings: [finding],
    })} />);

    expect(screen.getByRole('heading', { name: 'Evidence and conclusions' })).toBeTruthy();
    expect(screen.getByText('Evidence class: CONFIGURATION')).toBeTruthy();
    expect(screen.getByText('Conclusion: OBSERVED')).toBeTruthy();
    expect(screen.getAllByText(/Source span: line 3, column 5 to line 3, column 15/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Safe evidence: node\.configuration\.v2/)).toBeTruthy();
    expect(screen.getByText('Observation')).toBeTruthy();
    expect(screen.getByText('SECRET_INDICATOR')).toBeTruthy();
    expect(screen.queryByText(/sk_live_12345678/)).toBeNull();
    expect(screen.queryByText(/\/nodes\/0\/parameters/)).toBeNull();
  });

  it('renders standalone canonical facts without findings and without a false empty message', () => {
    render(<ReportEvidence model={model({
      facts: [fact('destination.v3', {
        parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com', authorityState: 'KNOWN',
        valueMode: 'DYNAMIC', reason: 'OVERSIZED', omitted: 1, inventoryStatus: 'LIMIT_EXCEEDED',
      })],
    })} />);

    expect(screen.getByRole('list', { name: 'Canonical facts' })).toBeTruthy();
    expect(screen.getByText('Parameter path')).toBeTruthy();
    expect(screen.getByText('/url')).toBeTruthy();
    expect(screen.getByText('Reason')).toBeTruthy();
    expect(screen.getByText('OVERSIZED')).toBeTruthy();
    expect(screen.getByText('Omitted')).toBeTruthy();
    expect(screen.queryByText(/No additional facts observed/)).toBeNull();
    expect(screen.queryByText(/No registered evidence/)).toBeNull();
  });

  it('makes a complete result with no facts explicit instead of claiming registered evidence', () => {
    render(<ReportEvidence model={model()} />);

    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('No additional facts observed in this result.');
    expect(note).not.toContain('No registered evidence');
  });

  it('states that canonical facts are unavailable for an incomplete check and names the reason', () => {
    render(<ReportEvidence model={model({
      analysis: {
        status: 'DEGRADED',
        capabilities: [{ id: 'javascript-security', status: 'DEGRADED', diagnosticIds: [digest] }],
        diagnostics: [{ id: digest, code: 'OPTIONAL_LIMIT_EXCEEDED', aggregateEffect: 'DEGRADED' }],
      },
    })} />);

    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('Canonical facts are unavailable');
    expect(note).toContain('javascript-security');
    expect(note).toContain('OPTIONAL_LIMIT_EXCEEDED');
    expect(note).toMatch(/not clean/i);
    expect(note).not.toContain('No additional facts observed');
  });

  it('redacts URL-shaped and secret-shaped fact values instead of dumping raw payloads', () => {
    render(<ReportEvidence model={model({
      facts: [fact('code.indicator.v2', {
        language: 'JAVASCRIPT', indicator: 'EVAL', start: 1, end: 2, parseState: 'VERIFIED',
        member: 'https://user:topsecret@example.com/callback?token=abc123&ok=1 sk_live_12345678',
      })],
    })} />);

    const text = screen.getByRole('list', { name: 'Canonical facts' }).textContent ?? '';
    expect(text).toContain('Member');
    expect(text).not.toContain('topsecret');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('sk_live_12345678');
    expect(text).toContain('[REDACTED]');
  });

  it('renders only the kind label for an unregistered fact kind', () => {
    render(<ReportEvidence model={model({
      facts: [fact('future.unknown-kind.v9', { secret: 'sk_live_12345678' })],
    })} />);

    const item = screen.getByRole('list', { name: 'Canonical facts' }).textContent ?? '';
    expect(item).toContain('future.unknown-kind.v9');
    expect(item).not.toContain('sk_live_12345678');
    expect(screen.queryByText('Secret')).toBeNull();
    expect(screen.getByText(/Properties are not displayed for an unregistered fact kind/)).toBeTruthy();
  });

  it('treats an inherited object key as an unregistered fact kind', () => {
    render(<ReportEvidence model={model({
      facts: [fact('toString', { secret: 'sk_live_12345678' })],
    })} />);

    const item = screen.getByRole('list', { name: 'Canonical facts' }).textContent ?? '';
    expect(item).toContain('toString');
    expect(item).not.toContain('sk_live_12345678');
    expect(screen.getByText(/Properties are not displayed for an unregistered fact kind/)).toBeTruthy();
  });

  it('renders canonical advisory status, coverage and v3 rationale while withholding hostile extra properties', () => {
    render(<ReportEvidence model={model({ facts: [
      { ...fact('advisory.evaluation.v1', { evaluationState: 'UNAVAILABLE', evaluationReason: 'NO_ADMITTED_SNAPSHOT',
        packagesRequested: 1, packagesCovered: 0, packageRowsOmitted: 0, recordsExamined: 0,
        recordsApplicable: 0, recordsNotApplicable: 0, recordsUnknown: 0, omissionReasons: [],
        snapshotSha256: 'private-snapshot-identity', secret: 'hostile-extra-property', raw: 'sk_live_12345678' }), factId: 'evaluation' },
      { ...fact('advisory.package-coverage.v1', { packageName: 'example-package', packageVersion: '1.0.0',
        coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE', raw: 'hostile-extra-property' }), factId: 'coverage' },
      fact('advisory.applicability.v3', { advisoryId: 'ADVISORY-1', packageName: 'example-package', installedVersion: '1.0.0',
        applicability: 'UNKNOWN', rowReason: 'TARGET_PREREQUISITE_UNKNOWN', reviewState: 'ADMITTED',
        matchedPrerequisites: [], unknownPrerequisites: ['role'], secret: 'hostile-extra-property' }),
    ] })} />);
    expect(screen.getByText('Advisory status: UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText('Package coverage: UNKNOWN')).toBeTruthy();
    expect(screen.getByText('Advisory applicability: UNKNOWN')).toBeTruthy();
    expect(screen.getByText('Required target context is unknown.')).toBeTruthy();
    expect(screen.getByText('1 unknown prerequisite: role')).toBeTruthy();
    const text = screen.getByRole('list', { name: 'Canonical facts' }).textContent;
    expect(text).not.toMatch(/hostile-extra-property|private-snapshot-identity|sk_live_12345678/);
    expect(screen.queryByText(/unregistered fact kind|No allowlisted fact properties|No additional facts/)).toBeNull();
  });
});
