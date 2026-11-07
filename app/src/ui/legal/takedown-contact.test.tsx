import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TakedownCopyright } from './takedown-copyright';
import { TakedownOtherRequests } from './takedown-other-requests';

const requestUrl = 'mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request';

describe('takedown request channels', () => {
  it('offers a public email channel only for routine, non-sensitive requests', () => {
    const { container } = render(<TakedownCopyright />);
    const requestLink = within(container).getByRole('link', { name: /email a routine takedown request/i });

    expect(requestLink.getAttribute('href')).toBe(requestUrl);
    expect(requestLink.getAttribute('aria-label')).toBe('email a routine takedown request');
    expect(requestLink.getAttribute('target')).toBeNull();
    expect(container.textContent).toMatch(/do not put personal data, credentials, or security details in email/i);
  });

  it('offers the private email for sensitive requests', () => {
    const { container } = render(<TakedownOtherRequests />);
    const emailLinks = within(container).getAllByRole('link', { name: 'voidsyntax01@gmail.com' });

    expect(emailLinks).toHaveLength(2);
    expect(emailLinks.every((link) => link.getAttribute('href') === 'mailto:voidsyntax01@gmail.com')).toBe(true);
  });
});
