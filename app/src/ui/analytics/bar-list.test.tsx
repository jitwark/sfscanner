import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BarList } from './bar-list';

afterEach(() => cleanup());

/**
 * P3.1 (2026-08-27): a long, data-driven label (an integration or node-type
 * name — this list has no fixed catalogue of short labels) is rendered
 * `whitespace-nowrap` for readability, so an auto-layout `<table>` sizes
 * itself to fit the longest one. Measured live at 320px viewport width
 * (`docs/audit/2026-08-26/baseline/phase-0-p0.4-baseline.md`'s `/analytics/`
 * finding): with no scroll container, that pushed the whole document wider
 * than the viewport. `policy-table.tsx` and `risk-matrix.tsx` already contain
 * the same shape of table in an `overflow-x-auto` wrapper; this pins that
 * `BarList` does the same, so the fix cannot silently regress.
 */
describe('BarList', () => {
  it('contains its table in a horizontally-scrollable wrapper, not the page', () => {
    const longLabel = 'AI · outputParserStructuredWithAVeryLongIntegrationNameThatWillNotWrap';
    const { container } = render(
      <BarList title="Most common node types" rows={[{ label: longLabel, count: 12 }]} total={100} />,
    );

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const wrapper = table!.parentElement;
    expect(wrapper?.className).toContain('overflow-x-auto');

    // The fix contains the overflow; it must not do so by hiding the data.
    expect(container.textContent).toContain(longLabel);
  });
});
