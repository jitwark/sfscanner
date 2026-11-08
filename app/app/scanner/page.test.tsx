import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScannerPage from './page';

vi.mock('@/src/scanner/scanner-client', () => ({
  ScannerClient: () => <div data-testid="scanner-client">Scanner client</div>,
}));

vi.mock('@/src/ui/scanner-guide', () => ({
  ScannerGuide: () => <div data-testid="scanner-guide">Scanner guide</div>,
}));

describe('ScannerPage', () => {
  it('sets a local single-export expectation without claiming every workflow had the same checks', () => {
    render(<ScannerPage />);

    expect(screen.getByRole('heading', { name: 'Check a workflow before you run it' })).toBeTruthy();
    expect(screen.getByText(/Paste or upload one workflow JSON export from n8n/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What this review gives you' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Risk grade and score' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Analysis coverage' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Next actions' })).toBeTruthy();
    expect(screen.getByText(/does not execute the workflow or prove runtime safety/i)).toBeTruthy();
    expect(screen.getByText(/Library entries can have different coverage and versions/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/every workflow.+same checks|same checks.+library/i);
    expect(screen.getByTestId('scanner-client')).toBeTruthy();
    expect(screen.getByTestId('scanner-guide')).toBeTruthy();
  });
});
