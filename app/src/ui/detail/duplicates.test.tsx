import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test-support/make-entry';
import { Duplicates } from './duplicates';

describe('Duplicates', () => {
  it('renders only duplicate URLs with HTTP or HTTPS schemes', () => {
    const entry = makeEntry({ dedup: { alsoFoundIn: [
      'https://example.test/workflow',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//example.test/workflow',
    ] } });

    render(<Duplicates entry={entry} />);

    expect(screen.getByRole('link', { name: 'https://example.test/workflow' }).getAttribute('href'))
      .toBe('https://example.test/workflow');
    expect(screen.queryByText('javascript:alert(1)')).toBeNull();
    expect(screen.queryByText('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(screen.queryByText('//example.test/workflow')).toBeNull();
  });
});
