import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CorpusAnalytics } from '@hub/contracts';
import { ScanCoveragePanel } from './scan-coverage';

afterEach(() => cleanup());

const evidence = {
  scannerVersion: '2.1.0',
  engineBuildDigest: 'a'.repeat(64),
  profileId: 'beta-default',
  profileVersion: '4',
  rulesetId: 'v2-default',
  rulesetVersion: '7',
  rulesetDigest: 'b'.repeat(64),
  signatureStatus: 'verified',
  semanticsId: 'catalogue',
  semanticsVersion: '2.1.0',
  semanticsDigest: 'c'.repeat(64),
  limitsDigest: 'd'.repeat(64),
  inventorySha256: 'e'.repeat(64),
  inventory: { available: 20, missing: 3, sourceUnavailable: 2 },
  states: { current: 19, noResult: 1, historical: 0, unscanned: 3, sourceUnavailable: 2 },
  current: { complete: 17, degraded: 2, indeterminate: 0 },
  excludedByRuling: 2,
} satisfies CorpusAnalytics['v2Evidence'];

const release = { generatedAt: '2026-10-20T00:00:00.000Z', corpusSha256: 'f'.repeat(64) };

const coverage = {
  total: 25,
  bodyAvailable: 22,
  scanned: 19,
  notScanned: 6,
  completed: 17,
  degraded: 2,
  indeterminate: 0,
  noResult: 1,
  noBody: 3,
  historical: 0,
  sourceUnavailable: 2,
} satisfies CorpusAnalytics['scanCoverage'];

describe('ScanCoveragePanel', () => {
  it('states one disjoint row per state and a total that reconciles to the catalogue', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    const totalRow = screen.getByText(/every entry lands in exactly one state/).closest('tr')!;
    expect(totalRow.textContent).toContain('25');
    expect(totalRow.textContent).toContain('100.0%');
  });

  it('describes the current result population without calling every row a verdict', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    expect(screen.getByText(/19 admitted native results · 1 engine refusals/)).toBeTruthy();
    const indeterminate = screen.getByText('Indeterminate').closest('tr')!;
    expect(indeterminate.textContent).toContain('no assessment is published');
    const refused = screen.getByText('No result (refused)').closest('tr')!;
    expect(refused.textContent).toContain('no native result exists');
    expect(refused.textContent).toContain('Not historical');
    const degraded = screen.getByText('Degraded').closest('tr')!;
    expect(degraded.textContent).toContain('assessment may be withheld');
    expect(document.body.textContent).not.toContain('Current v2 verdict');
  });

  it('separates admitted native results from engine refusals and never calls the latter current', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).toContain('19 rows are admitted native results (17 completed, 2 degraded, 0 indeterminate)');
    expect(copy).toContain('1 more were read by the current engine and refused');
    expect(copy).toContain('not historical, not unread, and never current or clean');
    expect(copy).toContain('the 20 bound readable inputs');
  });

  it('renders the full digest as selectable text, not only as a tooltip', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    expect(screen.getByText(evidence.engineBuildDigest)).toBeTruthy();
    expect(screen.getByText(release.corpusSha256)).toBeTruthy();
  });

  it('attributes the ruleset signature to the ruleset, not the scanner', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    const ruleset = screen.getByText('Ruleset').closest('div')!;
    expect(ruleset.textContent).toContain('signature verified');
    const scanner = screen.getByText('Scanner').closest('div')!;
    expect(scanner.textContent).not.toContain('verified');
  });

  it('names owner-ruled exclusions rather than hiding them inside source-unavailable', () => {
    render(<ScanCoveragePanel coverage={coverage} evidence={evidence} release={release} />);

    expect(screen.getByText(/2 of these are owner-ruled exclusions/)).toBeTruthy();
  });
});
