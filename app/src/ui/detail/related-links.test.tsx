import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RelatedLinks } from './related-links';

describe('RelatedLinks', () => {
  it('allows long unbroken workflow titles to wrap inside narrow pages', () => {
    render(<RelatedLinks links={[{ id: 'related', slug: 'related', title: 'workflow_with_a_long_unbroken_title' }]} />);
    expect(screen.getByRole('link', { name: 'workflow_with_a_long_unbroken_title' }).className).toContain('break-words');
  });

  it('encodes a generated slug as one workflow route segment', () => {
    render(<RelatedLinks links={[{ id: 'related', slug: 'folder/name?one', title: 'Related workflow' }]} />);
    expect(screen.getByRole('link', { name: 'Related workflow' }).getAttribute('href')).toBe('/w/folder%2Fname%3Fone/');
  });
});
