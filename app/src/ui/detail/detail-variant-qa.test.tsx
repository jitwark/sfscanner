import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DETAIL_VARIANT_MATRIX, type DetailVariant } from '../../catalogue/detail-variant-fixtures';
import { DetailBody } from './detail-body';

afterEach(() => cleanup());

function descriptionLabel(variant: DetailVariant): string {
  if (variant.description.source === 'upstream') return 'Upstream description';
  if (variant.description.source === 'fallback') return 'Fallback description';
  return variant.description.provenance === 'gemini' ? 'AI-generated description' : 'Description provenance unknown';
}

function assertRightsSurface(variant: DetailVariant, view: ReturnType<typeof within>, container: HTMLElement): void {
  const { entry, expectations } = variant;
  expect(view.getAllByText(entry.rights.reason).length).toBeGreaterThanOrEqual(1);
  expect(view.getAllByText(entry.rights.licence ?? 'Unlicensed').length).toBeGreaterThanOrEqual(1);

  if (expectations.action === 'download') {
    expect(view.getByRole('button', { name: 'Download workflow' })).toBeTruthy();
    expect(view.getByText('Includes the upstream licence notice.')).toBeTruthy();
    expect(entry.download).toBeDefined();
  } else {
    expect(view.queryByRole('button', { name: /download/i })).toBeNull();
    expect(view.queryByText('Includes the upstream licence notice.')).toBeNull();
    const sourceAction = entry.source.kind === 'n8n_official' ? 'View on n8n.io' : 'View on GitHub';
    expect(view.getByRole('link', { name: sourceAction })).toBeTruthy();
    expect(entry.download).toBeUndefined();
    if (expectations.action === 'none') {
      // Excluded entries have no body action; source navigation remains honest.
      expect(container.textContent).not.toContain('Download workflow');
    }
  }
}

function assertDescriptionSurface(variant: DetailVariant, view: ReturnType<typeof within>, container: HTMLElement): void {
  const { entry } = variant;
  expect(view.getByLabelText(descriptionLabel(variant))).toBeTruthy();

  if (variant.expectations.descriptionPublishable) {
    expect(entry.descriptionContent).toBeDefined();
    expect(view.getByText(entry.descriptionContent!.headline)).toBeTruthy();
    expect(view.queryByText(entry.description)).toBeNull();
    return;
  }

  if (entry.descriptionContent) expect(view.queryByText(entry.descriptionContent.headline)).toBeNull();
  if (entry.descriptionSource === 'upstream') {
    expect(view.getByText(entry.description)).toBeTruthy();
  } else {
    expect(view.getByText(/publishable description is not available/i)).toBeTruthy();
    expect(container.textContent).not.toContain(entry.description);
  }
}

describe('DetailBody synthetic P5.1 rendered variant matrix', () => {
  it('renders every rights, completeness, and provenance variant honestly', () => {
    for (const variant of DETAIL_VARIANT_MATRIX) {
      const { container } = render(<DetailBody entry={variant.entry} related={[]} />);
      const view = within(container);
      const { entry } = variant;

      expect(view.getByRole('heading', { level: 1, name: entry.title })).toBeTruthy();
      expect(view.getByRole('heading', { name: 'Provenance' })).toBeTruthy();
      expect(view.getByText(entry.source.kind === 'n8n_official' ? 'Official n8n template' : 'GitHub repository')).toBeTruthy();
      const sourceLabel = entry.source.kind === 'n8n_official' ? 'n8n.io' : (entry.source.repo ?? 'GitHub');
      expect(view.getAllByRole('link', { name: sourceLabel }).length).toBeGreaterThanOrEqual(2);

      if (variant.expectations.sourceFacts === 'complete') {
        expect(view.getByText('Synthetic Maintainer')).toBeTruthy();
      } else {
        expect(view.getByText('Unknown')).toBeTruthy();
        expect(view.queryByText('Path')).toBeNull();
        expect(view.queryByText('Commit')).toBeNull();
      }

      assertRightsSurface(variant, view, container);
      assertDescriptionSurface(variant, view, container);
      expect(view.getByRole('heading', { name: 'Before you run' })).toBeTruthy();

      if (variant.dimensions.completeness === 'complete') {
        expect(view.queryByRole('alert')).toBeNull();
        expect(view.getByText(/No pre-run signals were detected in the published readiness report/i)).toBeTruthy();
      } else {
        const warning = view.getByRole('alert');
        expect(warning.textContent).toMatch(/not treat it as ready to run|not ready to run/i);
        expect(warning.textContent).toMatch(/workflow body is unavailable/i);
      }

      expect(container.textContent).not.toMatch(/secret|password|api[-_]?key|token/i);
      cleanup();
    }
  }, 20_000);

  it('keeps missing source facts and description provenance fail-closed', () => {
    const variant = DETAIL_VARIANT_MATRIX.find((item) => item.id === 'detail-06-link-only-unknown-malformed-fallback')!;
    const { container } = render(<DetailBody entry={variant.entry} related={[]} />);
    const view = within(container);

    expect(view.getByText('Official n8n template')).toBeTruthy();
    expect(view.getByText('Unknown')).toBeTruthy();
    expect(view.getByText('Unlicensed')).toBeTruthy();
    expect(view.queryByText('Synthetic Maintainer')).toBeNull();
    expect(view.queryByText('Path')).toBeNull();
    expect(view.queryByText('Commit')).toBeNull();
    expect(view.getByLabelText('Fallback description')).toBeTruthy();
    expect(view.getByText(/publishable description is not available/i)).toBeTruthy();
    expect(view.queryByText(variant.entry.description)).toBeNull();
    expect(view.getByRole('alert').textContent).toMatch(/metadata-only|not ready to run/i);
  });

  it('renders an explicit generated description but withholds generated and fallback prose without proof', () => {
    const explicit = DETAIL_VARIANT_MATRIX.find((item) => item.description.provenance === 'gemini')!;
    const withheld = DETAIL_VARIANT_MATRIX.find((item) => item.dimensions.description === 'generated-unknown')!;
    const explicitView = within(render(<DetailBody entry={explicit.entry} related={[]} />).container);
    expect(explicitView.getByLabelText('AI-generated description')).toBeTruthy();
    expect(explicitView.getByText(explicit.entry.descriptionContent!.headline)).toBeTruthy();

    cleanup();
    const withheldView = within(render(<DetailBody entry={withheld.entry} related={[]} />).container);
    expect(withheldView.getByLabelText('Description provenance unknown')).toBeTruthy();
    expect(withheldView.queryByText(withheld.entry.descriptionContent!.headline)).toBeNull();
    expect(withheldView.queryByText(withheld.entry.description)).toBeNull();
    expect(withheldView.getByText(/publishable description is not available/i)).toBeTruthy();
  });
});
