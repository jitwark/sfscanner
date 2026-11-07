import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { ReadinessSignals } from './readiness-signals';

const base = {
  structure: { hasAI: false, isSubWorkflow: false },
} as unknown as Entry;

describe('ReadinessSignals', () => {
  afterEach(() => cleanup());

  it('renders every populated readiness and hostname signal', () => {
    render(<ReadinessSignals entry={{ ...base, structure: { ...base.structure, hasAI: true, isSubWorkflow: true }, readiness: { credentials: ['Slack'], replaceableValues: [{ node: 'Webhook', field: 'parameters.url', kind: 'url' }], writeActions: ['sends Slack messages'], aiModel: { present: true, model: 'gpt-test' }, extraPackages: ['n8n-nodes-community'], versionNotes: ['Uses a legacy node'], pinnedData: { present: true, nodeCount: 3 }, isSubWorkflow: true }, hostnames: { literal: ['api.example.test'], dynamic: [{ host: 'api.dynamic.test' }], undeterminable: 1 } } as Entry} />);
    expect(screen.getByText('gpt-test')).toBeTruthy();
    expect(screen.getByText('Slack')).toBeTruthy();
    expect(screen.getByText('parameters.url')).toBeTruthy();
    expect(screen.getByText('sends Slack messages')).toBeTruthy();
    expect(screen.getByText('api.example.test')).toBeTruthy();
    expect(screen.getByText('api.dynamic.test')).toBeTruthy();
    expect(screen.getByText(/could not be determined/)).toBeTruthy();
    expect(screen.getByText('n8n-nodes-community')).toBeTruthy();
    expect(screen.getByText('Uses a legacy node')).toBeTruthy();
    expect(screen.getByText(/sub-workflow/)).toBeTruthy();
    expect(screen.getByText(/pinned test execution data/)).toBeTruthy();
    expect(screen.getByText(/No credential values are stored here/)).toBeTruthy();
  });

  it('does not imply readiness when no pre-run report is published', () => {
    const { container } = render(<ReadinessSignals entry={base} />);
    const view = within(container);
    expect(view.getByRole('heading', { name: 'Before you run' })).toBeTruthy();
    expect(view.getByText(/No pre-run readiness report is published/)).toBeTruthy();
  });

  it('warns that metadata-only entries are not ready when the body and readiness report are unavailable', () => {
    const { container } = render(<ReadinessSignals entry={{ ...base, structure: { ...base.structure, partial: true } }} />);
    const warning = within(container).getByRole('alert');
    expect(warning.textContent).toMatch(/workflow body is unavailable/i);
    expect(warning.textContent).toMatch(/metadata[- ]only/i);
    expect(warning.textContent).toMatch(/do not treat it as ready to run/i);
  });

  it('says credential readiness is unknown, not empty, when the entry was never scanned', () => {
    const unscanned = {
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
    const { container } = render(<ReadinessSignals entry={{ ...base, structure: { ...base.structure, partial: true }, readiness: unscanned } as Entry} />);

    const warning = within(container).getByRole('alert');
    expect(warning.textContent).toMatch(/No workflow JSON was available for analysis/);
    expect(warning.textContent).toMatch(/unknown, not confirmed absent/);
    expect(warning.textContent).toMatch(/partial structure data/);
    // The empty list must not be read as "this workflow needs no credentials".
    expect(within(container).queryByText(/No pre-run signals were detected/)).toBeNull();
  });

  /**
   * Task 6.6's labelling clause. The 1,791 rows with no authorized body keep
   * their historical compatibility, hostname, replaceable-value, write-action
   * and AI-model values, and the section-level disclaimer above them is not
   * enough: each group must say the values were never produced by the current
   * engine, or a reader takes them for current derivations.
   *
   * The scanned row is the control. Both rows carry identical signal values, so
   * deleting the notes the unscanned row added has to reproduce the scanned
   * row's markup exactly — that is what proves the labels appear only where
   * they belong and change nothing else.
   */
  it('labels every historical value group on an unscanned row and leaves the scanned row untouched', () => {
    const readinessValues = {
      credentials: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
      replaceableValues: [{ node: 'Webhook', field: 'parameters.url', kind: 'url' as const }],
      writeActions: ['sends Slack messages'],
      aiModel: { present: true, model: 'gpt-test' },
      extraPackages: ['n8n-nodes-community'],
      versionNotes: ['Uses a legacy node'],
    };
    const entry: Entry = {
      ...base,
      readiness: { ...readinessValues, analysis: 'derived' },
      hostnames: { literal: ['api.example.test'], dynamic: [{ host: 'api.dynamic.test' }], undeterminable: 1 },
      compatibility: {
        targetVersion: '2.1.0',
        checkedAt: '2026-08-21T14:30:00.000Z',
        source: 'catalogue scanner',
        status: 'likely-compatible',
        reasons: ['All referenced nodes are available.'],
        blockers: [],
      },
    };

    const unscanned = render(<ReadinessSignals entry={{ ...entry, readiness: { ...readinessValues, analysis: 'unscanned' } }} />).container;
    const scanned = render(<ReadinessSignals entry={entry} />).container;
    expect(scanned.textContent).not.toMatch(/Historical derivation/);
    // The compatibility claim still reads as current on a scanned row.
    expect(scanned.querySelector('[aria-label="Compatibility notes"]')?.textContent).toMatch(/n8n 2\.1\.0/);

    for (const label of ['AI model', 'Values to replace before running', 'Write / mutating actions', 'External hosts contacted', 'Compatibility notes']) {
      const unscannedCard = unscanned.querySelector(`[aria-label="${label}"]`)?.innerHTML ?? '';
      // React's generated `useId` values differ per render, so ids come out of
      // the comparison; every other byte of the group must be identical.
      const scannedCard = (scanned.querySelector(`[aria-label="${label}"]`)?.innerHTML ?? '').replace(/ id="[^"]*"/g, '');
      expect(unscannedCard).toMatch(/Historical derivation/);
      expect(unscannedCard.replace(/<p[^>]*>Historical derivation:[^<]*<\/p>/g, '').replace(/ id="[^"]*"/g, ''))
        .toBe(scannedCard);
    }
  });

  it('distinguishes an empty published report from a missing report', () => {
    const emptyReadiness = {
      credentials: [],
      replaceableValues: [],
      writeActions: [],
      aiModel: { present: false, model: null },
      extraPackages: [],
      versionNotes: [],
      pinnedData: { present: false, nodeCount: 0 },
      isSubWorkflow: false,
    };
    render(<ReadinessSignals entry={{ ...base, readiness: emptyReadiness } as Entry} />);

    expect(screen.getByText(/No pre-run signals were detected in the published readiness report/)).toBeTruthy();
    expect(screen.queryByText(/No pre-run readiness report is published/)).toBeNull();
  });
});
