import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrivacyPage from './page';

// This project does not enable Vitest globals, so Testing Library's automatic
// per-test cleanup never registers and renders accumulate in one document.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PrivacyPage', () => {
  it('does not promise a rebuild cadence with no supporting automation', () => {
    render(<PrivacyPage />);

    // No `schedule:` trigger exists anywhere in .github/workflows/, and no
    // other doc states a fixed cadence -- so the page must not claim one.
    const removalSection = screen.getByText(/takedown request page/i).closest('p');
    expect(removalSection?.textContent).not.toMatch(/\bmonthly\b/i);
    expect(removalSection?.textContent).not.toMatch(/sooner on request/i);
  });
});
