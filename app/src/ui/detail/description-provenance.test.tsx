import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DescriptionProvenance } from './description-provenance';

describe('DescriptionProvenance', () => {
  it('expands and collapses explicit generation details with a full-size target', () => {
    const { container } = render(<DescriptionProvenance
      descriptionSource="generated"
      descriptionProvenance={{ source: 'gemini', model: 'explicit-model', generatedAt: '2026-08-21T14:30:00.000Z' }}
    />);

    const view = within(container);
    expect(view.getByLabelText('AI-generated description')).toBeTruthy();
    const summary = view.getByText('Generation details').closest('summary')!;
    const details = summary.parentElement as HTMLDetailsElement;
    expect(summary.className).toContain('min-h-11');
    expect(summary.className).toContain('hover:bg-raised');
    expect(summary.className).toContain('focus-visible:ring-2');
    expect(summary.className).toContain('active:bg-panel');
    expect(summary.className).toContain('group-open:bg-raised');
    expect(summary.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it.each([
    ['upstream', { source: 'upstream' as const }, 'Upstream description'],
    ['upstream', undefined, 'Upstream description'],
    ['fallback', { source: 'fallback' as const }, 'Fallback description'],
    ['generated', undefined, 'Description provenance unknown'],
    ['generated', { source: 'unknown' as const }, 'Description provenance unknown'],
  ] as const)('labels %s provenance accurately', (descriptionSource, descriptionProvenance, label) => {
    const { container } = render(<DescriptionProvenance descriptionSource={descriptionSource} descriptionProvenance={descriptionProvenance} />);
    const view = within(container);
    expect(view.getByLabelText(label)).toBeTruthy();
    expect(view.queryByText('Generation details')).toBeNull();
    expect(container.textContent).not.toMatch(/Gemini/i);
  });
});
