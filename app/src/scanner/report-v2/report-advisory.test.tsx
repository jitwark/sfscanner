import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { buildAdvisoryFactsV1, validateTargetContextV3, createAdvisoryCatalogueDigest } from '@hub/scanner-core/v2';
import { readAdvisoryFactPropertiesV1 } from '@hub/contracts/scanner-v2-advisory-validation';
import type { SafeFactV2 } from '@hub/contracts/scanner-v2-evidence';
import { buildSyntheticAdmittedAdvisoryFactsV3, type SyntheticAdvisoryAdmissionV3 } from '../../../../packages/scanner-core/src/advisories/synthetic-advisory-evaluation';
import { AdvisoryFactDetails, ReportAdvisoryStatus } from './report-advisory';

afterEach(cleanup);
const target = validateTargetContextV3({ schemaVersion: 'scanner-target-v3',
  communityPackages: [{ name: 'example-package', version: '1.0.0' }, { name: 'example-package', version: '2.0.0' }], configuration: [] });
const digest = 'a'.repeat(64);
// Test-only admitted evaluation. Production remains unable to evaluate without verified data.
function syntheticFacts(partial: boolean, maxPackages = 100, reviewState: 'ADMITTED' | 'WITHDRAWN' = 'ADMITTED') {
  const records: SyntheticAdvisoryAdmissionV3['records'] = [{
    id: 'ADVISORY-1', aliases: ['ADVISORY-1'], packageName: 'example-package', rawAffectedRange: '>=1.0.0',
    affected: { clauses: [[{ op: 'GTE', version: '1.0.0' }]] }, fixedVersions: [], fixedBranches: [], prerequisites: [],
    sourceUrl: 'https://example.test/advisory/ADVISORY-1', sourceDigest: digest, reviewedAt: '2026-11-03', reviewer: 'fixture', reviewState,
  }];
  return buildSyntheticAdmittedAdvisoryFactsV3({ target, admission: {
    bounds: { maxPackages, maxRowsPerPackage: 100, maxRows: partial ? 1 : 100, maxAgeMs: 60_000 },
    sourceId: 'fixture-source', pinDigest: digest, coverageDigest: digest, rightsReceiptDigest: digest,
    provenanceReceiptDigest: digest, boundsDigest: digest, admissionReceiptDigest: digest,
    pinnedSnapshotSha256: digest, snapshotSha256: digest, capturedAt: '2026-11-03T00:00:00.000Z',
    admittedAt: '2026-11-03T00:00:01.000Z', evaluatedAt: '2026-11-03T00:00:02.000Z', catalogueVersion: '1.0.0',
    catalogueDigest: createAdvisoryCatalogueDigest({ schemaVersion: 'scanner-advisories-v2', version: '1.0.0', records }),
    coverageClaimed: true, coveredPairs: target.communityPackages.map((pair) => ({ packageName: pair.name, packageVersion: pair.version ?? null })), records,
  } });
}

it.each([false, true])('shows canonical evaluation counts and omissions (partial=%s)', (partial) => {
  const facts = syntheticFacts(partial);
  render(<ReportAdvisoryStatus facts={facts} />);
  expect(screen.getByText(`Advisory status: ${partial ? 'PARTIAL' : 'COMPLETE'}`)).toBeTruthy();
  expect(screen.getByText('Package versions covered').nextElementSibling?.textContent).toBe('2');
  expect(screen.getByText('Advisory records examined').nextElementSibling?.textContent).toBe('2');
  expect(screen.getByText('Applicable records').nextElementSibling?.textContent).toBe(partial ? '1' : '2');
  if (partial) expect(screen.getByText(/Some advisory records were omitted because the record limit/)).toBeTruthy();
  expect(screen.queryByText(digest)).toBeNull();
});

it('keeps package omissions distinct from evaluated advisory records', () => {
  render(<ReportAdvisoryStatus facts={syntheticFacts(false, 1)} />);
  expect(screen.getByText('Package versions omitted').nextElementSibling?.textContent).toBe('1');
  expect(screen.getByText('Advisory records examined').nextElementSibling?.textContent).toBe('1');
  expect(screen.getByText(/Some package versions were omitted/)).toBeTruthy();
});

it('shows unknown advisory counts independently of package coverage', () => {
  render(<ReportAdvisoryStatus facts={syntheticFacts(false, 100, 'WITHDRAWN')} />);
  expect(screen.getByText('Advisory status: PARTIAL')).toBeTruthy();
  expect(screen.getByText('Unknown records').nextElementSibling?.textContent).toBe('2');
  expect(screen.getByText('Package versions covered').nextElementSibling?.textContent).toBe('2');
});

it.each([
  ['APPLICABLE', 'IN_AFFECTED_RANGE', ['role'], [], /known prerequisites match/],
  ['NOT_APPLICABLE', 'PREREQUISITE_MISMATCH', [], [], /known prerequisite excludes/],
  ['UNKNOWN', 'TARGET_PREREQUISITE_UNKNOWN', [], ['role'], /Required target context is unknown/],
] as const)('shows canonical %s rationale and prerequisites', (applicability, rowReason, matchedPrerequisites, unknownPrerequisites, rationale) => {
  const fact: SafeFactV2 = { factId: digest, kind: 'advisory.applicability.v3', subject: { kind: 'WORKFLOW' }, properties: {
    advisoryId: 'ADVISORY-1', packageName: 'example-package', installedVersion: '1.0.0', reviewState: 'ADMITTED',
    applicability, rowReason, matchedPrerequisites, unknownPrerequisites,
  } };
  expect(readAdvisoryFactPropertiesV1(fact.kind, fact.properties)).toBeDefined();
  render(<AdvisoryFactDetails fact={fact} />);
  expect(screen.getByText(`Advisory applicability: ${applicability}`)).toBeTruthy();
  expect(screen.getByText(rationale)).toBeTruthy();
  expect(screen.getByText(new RegExp(`${unknownPrerequisites.length} unknown prerequisite`))).toBeTruthy();
});

it('withholds hostile extra fields and sanitizes selected text', () => {
  const fact = buildAdvisoryFactsV1({ target, request: { requested: true, inventoryState: 'DECLARED' } })[1];
  render(<AdvisoryFactDetails fact={{ ...fact, properties: { ...fact.properties,
    packageName: 'https://user:topsecret@example.test/?token=canary', secret: 'hostile-extra-property', raw: 'sk_live_12345678' } }} />);
  expect(document.body.textContent).not.toMatch(/topsecret|canary|hostile-extra-property|sk_live_12345678/);
  expect(screen.getByText('Package coverage: UNKNOWN')).toBeTruthy();
});
