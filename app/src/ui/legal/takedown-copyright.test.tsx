import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TakedownCopyright } from './takedown-copyright';

/**
 * The safety net `legal-contacts.ts`'s own doc comment claims exists: a page
 * must never imply DMCA safe-harbour compliance it has not earned. The real
 * `dmcaAgent` block is all-`PENDING` today, so this renders the actual
 * component against actual module state rather than a fabricated one —
 * exactly the claim-while-unfilled case the comment describes.
 */

describe('TakedownCopyright safe-harbour claim', () => {
  it('does not claim DMCA safe-harbour compliance while the real agent block is unfilled', () => {
    const { container } = render(<TakedownCopyright />);

    // The compliance claim is the published agent's contact details.
    // Real module state today is all-PENDING, so none of them may render.
    expect(within(container).queryByText('Telephone')).toBeNull();
    expect(within(container).queryByText('Address')).toBeNull();

    // The explicit non-claim notice must render instead.
    expect(
      within(container).getByText(/makes no claim to the DMCA section 512\(c\) safe harbour/i),
    ).toBeTruthy();
  });

  it('states the statutory notice and counter-notice conditions precisely', () => {
    const { container } = render(<TakedownCopyright />);
    const text = container.textContent ?? '';

    expect(text).toContain('may not qualify as an effective statutory notification');
    expect(text).not.toContain('cannot be acted on');
    expect(text).toContain('acceptance of service of process');
    expect(text).toContain('district where your address is located');
    expect(text).toContain('outside the United States');
  });
});
