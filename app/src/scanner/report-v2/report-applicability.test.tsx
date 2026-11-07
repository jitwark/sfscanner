import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { ReportApplicability } from './report-applicability';
import { scanWorkflowV2, validateTargetContextV3 } from '@hub/scanner-core/v2';
import { toScannerReportModelV2 } from '../scanner-v2-presentation';

const digest = 'c'.repeat(64);

function model(): ScannerReportModelV2 {
  return {
    v2: {
      schemaVersion: 'scanner-result-v2',
      target: { schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'CLOUD', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [{ key: 'taskRunner', state: 'UNKNOWN' }], contextDigest: digest },
      facts: [{ factId: digest, kind: 'advisory.applicability.v3', subject: { kind: 'WORKFLOW' }, properties: { advisoryId: 'ADVISORY-1', packageName: 'example-package', installedVersion: '1.0.0', applicability: 'UNKNOWN', rowReason: 'TARGET_PREREQUISITE_UNKNOWN', reviewState: 'ADMITTED', matchedPrerequisites: [], unknownPrerequisites: ['n8nVersion', 'role'] } }],
      findings: [
        { findingId: digest, ruleId: 'ADVISORY-1', ruleRevision: '1', effect: 'REPORT_ONLY', severity: 'INFO', confidence: 'LOW', evidenceClass: 'VERSION_APPLICABILITY', conclusion: 'UNKNOWN', applicability: 'UNKNOWN', subject: { kind: 'WORKFLOW' }, factRefs: [digest], traceRefs: [], remediationId: 'review' },
        { findingId: 'd'.repeat(64), ruleId: 'KNOWN-1', ruleRevision: '1', effect: 'SCORING', severity: 'LOW', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'WORKFLOW' }, factRefs: [], traceRefs: [], remediationId: 'review' },
      ],
    },
  } as unknown as ScannerReportModelV2;
}

function productionModel(inventoryState?: 'DECLARED' | 'UNVERIFIED', communityPackages = [{ name: 'example-package', version: '1.0.0' }]) {
  const result = scanWorkflowV2({
    bytes: Uint8Array.from(new TextEncoder().encode('{"nodes":[],"connections":{}}')), profile: { id: 'beta-default', version: '2.0.0' },
    target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages, configuration: [] }),
    ...(inventoryState ? { advisoryRequest: { requested: true, inventoryState } } : {}),
  });
  if (!result.ok) throw new Error(result.code);
  return toScannerReportModelV2(result.result);
}

describe('ReportApplicability', () => {
  afterEach(cleanup);
  it('explains unknown applicability and target-context limitations without guessing', () => {
    render(<ReportApplicability model={model()} />);

    expect(screen.getByRole('heading', { name: 'Applicability and target context' })).toBeTruthy();
    expect(screen.getByText('Applicability: UNKNOWN')).toBeTruthy();
    expect(screen.getByText(/No applicability claim is made/)).toBeTruthy();
    expect(screen.getByText(/n8nVersion, edition, role, taskRunner/)).toBeTruthy();
    expect(screen.getByText(/Target context is partial/)).toBeTruthy();
    expect(screen.getAllByText(/ADVISORY-1/).length).toBeGreaterThan(0);
  });

  it('does not infer an advisory check from missing evaluation metadata', () => {
    const empty = { ...model(), v2: { ...model().v2, findings: [], facts: [] } } as ScannerReportModelV2;
    render(<ReportApplicability model={empty} />);

    expect(screen.getByText(/Advisory status: UNKNOWN/)).toBeTruthy();
    expect(screen.queryByText(/No applicability evidence was returned/)).toBeNull();
  });

  it('renders default NOT_REQUESTED from the actual canonical result producer', () => {
    render(<ReportApplicability model={productionModel()} />);
    expect(screen.getByText('Advisory status: NOT_REQUESTED')).toBeTruthy();
    expect(screen.getByText('Advisory checks were not requested.')).toBeTruthy();
    expect(screen.queryByText(/Advisory status: UNAVAILABLE/)).toBeNull();
  });

  it('renders requested UNAVAILABLE and exact package-version UNKNOWN coverage without a false empty conclusion', () => {
    render(<ReportApplicability model={productionModel('DECLARED', [
      { name: 'example-package', version: '1.0.0' }, { name: 'example-package', version: '2.0.0' },
    ])} />);
    expect(screen.getByText('Advisory status: UNAVAILABLE')).toBeTruthy();
    expect(screen.getAllByText('Package coverage: UNKNOWN')).toHaveLength(2);
    const coverage = screen.getByRole('list', { name: 'Advisory package coverage' });
    expect(coverage.textContent).toContain('1.0.0');
    expect(coverage.textContent).toContain('2.0.0');
    expect(screen.getByText('Package versions requested').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByText('Package versions covered').nextElementSibling?.textContent).toBe('0');
    expect(screen.queryByText(/No applicability evidence was returned|No admitted advisory applicability record|clean/i)).toBeNull();
  });

  it('renders requested REFUSED independently of an empty list of applicability rows', () => {
    render(<ReportApplicability model={productionModel('UNVERIFIED')} />);
    expect(screen.getByText('Advisory status: REFUSED')).toBeTruthy();
    expect(screen.getByText('The installed package inventory has not been verified.')).toBeTruthy();
    expect(screen.queryByText(/NOT_REQUESTED/)).toBeNull();
  });

  it('distinguishes explicitly empty declared inventory from opting out', () => {
    render(<ReportApplicability model={productionModel('DECLARED', [])} />);
    expect(screen.getByText('Advisory status: NO_DECLARED_PACKAGES')).toBeTruthy();
    expect(screen.getByText(/does not establish that no packages are installed/)).toBeTruthy();
  });
});
