import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScannerInput } from './scanner-input';
import { MAX_WORKFLOW_BYTES } from './scanner-input-validation';

const workflowJson = JSON.stringify({
  name: 'Pasted workflow',
  nodes: [{ name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
  connections: {},
});

const expectedRequest = {
  json: workflowJson,
  profile: 'beta-default' as const, // ScannerInput.submit sends the only admitted profile (scanner-input.tsx:84)
  approvedDomains: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScannerInput text submission boundaries', () => {
  it('submits text entered by a direct paste exactly once after the explicit scan action', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);
    const editor = screen.getByRole('textbox', { name: 'Workflow JSON' });

    fireEvent.paste(editor, {
      clipboardData: { getData: (kind: string) => (kind === 'text/plain' ? workflowJson : '') },
    });
    // fireEvent does not perform the browser's default insertion into a controlled textarea.
    fireEvent.change(editor, { target: { value: workflowJson } });

    expect(onScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(expectedRequest);
  });

  it('submits plain text dropped on the drop zone exactly once', () => {
    const onScan = vi.fn();
    const getData = vi.fn((kind: string) => (kind === 'text' ? workflowJson : ''));
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]')!;

    fireEvent.drop(dropTarget, { dataTransfer: { files: [], getData } });

    expect(getData).toHaveBeenCalledWith('text');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(expectedRequest);
  });

  it('rejects oversized dropped text before onScan', () => {
    const onScan = vi.fn();
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]')!;

    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [], getData: () => 'x'.repeat(MAX_WORKFLOW_BYTES + 1) },
    });

    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('larger than');
  });

  it('rejects oversized typed text before onScan', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);

    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: 'x'.repeat(MAX_WORKFLOW_BYTES + 1) } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('larger than');
  });
});
