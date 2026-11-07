import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DescriptionSections } from './description-sections';

describe('DescriptionSections', () => {
  it('owns step numbering instead of duplicating model numbering', () => {
    render(<DescriptionSections content={{ headline: 'A useful workflow explanation', summary: 'A useful workflow explanation for readers.', outcome: 'It explains the result in plain words.', beforeAfter: { before: 'Before.', after: 'After.' }, exampleScenario: 'Example: imagine a person using it.', howItWorks: ['1. Receive the request.', '2) Send the message.', 'Finish the run.'], limitations: ['Credentials are needed.'], audience: 'People learning n8n.' }} />);
    const list = screen.getByRole('list', { name: 'How it works' });
    expect(list.textContent).toContain('Receive the request.');
    expect(list.textContent).not.toContain('1. Receive');
  });
});
