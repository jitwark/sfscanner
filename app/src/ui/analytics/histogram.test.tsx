import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Histogram } from './histogram';

afterEach(() => cleanup());

describe('Histogram', () => {
  it('keeps semantic table rows as table layout elements', () => {
    const { container } = render(
      <Histogram
        title="Workflow size"
        bins={[{ label: '1–5', min: 1, max: 5, count: 3 }]}
      />,
    );

    const rows = Array.from(container.querySelectorAll('tbody > tr'));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.classList.contains('flex'))).toBe(true);
    expect(container.querySelector('table')).not.toBeNull();
  });
});
