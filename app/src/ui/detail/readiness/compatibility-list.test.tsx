import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompatibilityList } from './compatibility-list';

describe('CompatibilityList', () => {
  // No ambient `afterEach`: `globals` is off, so RTL never registers its own
  // cleanup and a second render of the same text lands in one document.
  afterEach(() => cleanup());

  it('renders extra packages and version notes', () => {
    render(<CompatibilityList readiness={{ credentials: [], replaceableValues: [], writeActions: [], aiModel: { present: false, model: null }, extraPackages: ['n8n-nodes-example'], versionNotes: ['Uses a legacy node'], pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false }} />);
    expect(screen.getByText('n8n-nodes-example')).toBeTruthy();
    expect(screen.getByText('Uses a legacy node')).toBeTruthy();
  });

  it('omits when optional readiness is missing or empty', () => {
    const { rerender } = render(<CompatibilityList />);
    expect(screen.queryByRole('section')).toBeNull();
    rerender(<CompatibilityList readiness={{ credentials: [], replaceableValues: [], writeActions: [], aiModel: { present: false, model: null }, extraPackages: [], versionNotes: [], pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false }} />);
    expect(screen.queryByRole('section')).toBeNull();
  });

  it('renders compatibility facts without inventing a missing reason', () => {
    render(<CompatibilityList compatibility={{
      targetVersion: '2.0.0',
      checkedAt: '2026-08-20T00:00:00.000Z',
      source: 'package lock',
      status: 'review-required',
      reasons: [],
      blockers: ['Community node version is unknown'],
    }} />);

    expect(screen.getByText('n8n 2.0.0')).toBeTruthy();
    expect(screen.getByText('Review before import')).toBeTruthy();
    expect(screen.getByText('Community node version is unknown')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Review blockers' })).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
    expect(screen.getByText(/No compatibility reason was published/)).toBeTruthy();
    // A scanned row's claim is current, so it carries no historical label.
    expect(screen.queryByText(/Historical derivation/)).toBeNull();
  });

  it('labels an unscanned compatibility claim as historical without hiding it', () => {
    const { container } = render(<CompatibilityList isUnscanned compatibility={{
      targetVersion: '2.1.0',
      checkedAt: '2026-08-21T14:30:00.000Z',
      source: 'catalogue scanner',
      status: 'likely-compatible',
      reasons: ['All referenced nodes are available.'],
      blockers: [],
    }} />);

    expect(container.textContent).toMatch(/Historical derivation/);
    // Labelled, not suppressed: a reader may still want the historical value.
    expect(screen.getByText('n8n 2.1.0')).toBeTruthy();
  });

  it('renders compatibility source, check date, and every published reason', () => {
    render(<CompatibilityList compatibility={{
      targetVersion: '2.1.0',
      checkedAt: '2026-08-21T14:30:00.000Z',
      source: 'catalogue scanner',
      status: 'likely-compatible',
      reasons: ['All referenced nodes are available.', 'No removed settings were detected.'],
      blockers: [],
    }} />);

    expect(screen.getByText('catalogue scanner')).toBeTruthy();
    const checkedAt = screen.getByText('21 Aug 2026');
    expect(checkedAt.closest('time')?.getAttribute('datetime')).toBe('2026-08-21T14:30:00.000Z');
    expect(screen.getByText('All referenced nodes are available.')).toBeTruthy();
    expect(screen.getByText('No removed settings were detected.')).toBeTruthy();
  });
});
