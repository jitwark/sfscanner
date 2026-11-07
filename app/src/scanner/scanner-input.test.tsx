import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WORKFLOW_BYTES, MAX_WORKFLOW_BYTES_LABEL, ScannerInput } from './scanner-input';
import { ScannerLimits } from './guide/scanner-limits';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ScannerInput', () => {
  /**
   * PERF-3. A textarea holding a large workflow is re-laid-out in full whenever
   * the page's layout is invalidated, and rendering the report does exactly
   * that: the 507 KiB stress fixture cost a 50 ms main-thread block (median max
   * frame gap 84 ms with the editor in layout, 34 ms without) to lay out text
   * nobody is reading while they read the report.
   *
   * This asserts the editor is *absent from the tree* rather than merely
   * visually hidden — `display:none` was the only mitigation that worked, and
   * a CSS-only version of it would be undone by anyone restyling the panel.
   * The text must survive in state, and there must be a way back to it.
   */
  it('takes the editor out of the layout once a report is on screen, without losing the JSON', () => {
    const onScan = vi.fn();
    const { rerender } = render(<ScannerInput isScanning={false} onScan={onScan} />);

    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{"nodes":[1,2,3]}' } });
    rerender(<ScannerInput isScanning={false} hasResult onScan={onScan} />);

    expect(screen.queryByLabelText('Workflow JSON')).toBeNull();
    expect(screen.getByText(/Scanned workflow/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    const restored = screen.getByLabelText('Workflow JSON') as HTMLTextAreaElement;
    expect(restored.value).toBe('{"nodes":[1,2,3]}');
  });

  it('keeps the editor while there is no report', () => {
    render(<ScannerInput isScanning={false} onScan={vi.fn()} />);
    expect(screen.getByLabelText('Workflow JSON')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit JSON' })).toBeNull();
  });

  it('keeps the static heading and input shell before a result at 320px-like width', () => {
    const { container } = render(
      <div style={{ width: '320px' }}>
        <ScannerInput isScanning={false} onScan={vi.fn()} />
      </div>,
    );

    expect((container.firstElementChild as HTMLElement).style.width).toBe('320px');
    expect(screen.getByRole('heading', { name: 'Scan a workflow' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Workflow JSON' })).toBeTruthy();
    expect(screen.getByText('Paste JSON or drop an n8n Download file.')).toBeTruthy();
    expect(screen.queryByText(/Scanned workflow/)).toBeNull();
  });

  it('keeps controls touch-sized and structurally wrappable without fixed-width children', () => {
    const { container } = render(
      <div style={{ width: '320px' }}>
        <ScannerInput isScanning={false} onScan={vi.fn()} />
      </div>,
    );
    const editor = screen.getByRole('textbox', { name: 'Workflow JSON' });
    const dropZone = editor.closest('[aria-disabled]') as HTMLElement;
    const scannerRoot = dropZone.parentElement as HTMLElement;
    const actionRow = screen.getByRole('button', { name: 'Scan workflow' }).parentElement as HTMLElement;
    const actionGroup = screen.getByRole('button', { name: 'Upload .json' }).parentElement as HTMLElement;

    expect(actionRow.className).toContain('flex-col');
    expect(actionGroup.className).toContain('flex-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Load safe sample' }));
    for (const button of screen.getAllByRole('button')) expect(button.className).toContain('min-h-11');
    expect(editor.className).toContain('w-full');

    fireEvent.click(screen.getByRole('button', { name: 'Expected domains' }));
    expect(screen.getByRole('textbox', { name: 'Hosts you expect this workflow to contact' }).className).toContain('min-h-11');

    const fixedWidth = /\b(?:w|min-w|max-w)-\[\d+(?:\.\d+)?(?:px|rem)\]/;
    const descendants = [scannerRoot, ...Array.from(scannerRoot.querySelectorAll<HTMLElement>('*'))];
    expect(descendants.some((element) => fixedWidth.test(element.className) || element.style.width)).toBe(false);
  });

  it('keeps the editor on an explicit focus-visible affordance path', () => {
    render(<ScannerInput isScanning={false} onScan={vi.fn()} />);

    const editor = screen.getByRole('textbox', { name: 'Workflow JSON' });
    expect(editor.className).toContain('focus-visible:ring-2');
    expect(editor.className).toContain('focus-visible:ring-accent-border');
    expect(editor.className).not.toContain('focus:outline-none');
  });

  it('loads a safe synthetic sample without submitting it', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load safe sample' }));

    const editor = screen.getByLabelText('Workflow JSON') as HTMLTextAreaElement;
    expect(editor.value).toContain('SecureFlow safe sample');
    expect(editor.value).toContain('Manual Trigger');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('clears JSON, domains, and validation errors without submitting', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);
    const editor = screen.getByLabelText('Workflow JSON');
    fireEvent.change(editor, { target: { value: '{"nodes":[]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expected domains' }));
    fireEvent.change(screen.getByLabelText('Hosts you expect this workflow to contact'), { target: { value: 'https://user:pass@bad.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect((screen.getByLabelText('Workflow JSON') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Hosts you expect this workflow to contact') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('accepts a dropped workflow file through the same submit boundary', async () => {
    const onScan = vi.fn();
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]')!;
    const file = new File(['{"nodes":[],"connections":{}}'], 'sample.json', { type: 'application/json' });

    fireEvent.drop(dropTarget, { dataTransfer: { files: [file], getData: () => '' } });

    await waitFor(() => expect(onScan).toHaveBeenCalledWith({
      json: '{"nodes":[],"connections":{}}',
      profile: 'beta-default', // ScannerInput.submit sends the only admitted profile (scanner-input.tsx:84)
      approvedDomains: [],
    }));
  });

  it('does not echo an uploaded filename into the UI or URL', async () => {
    const onScan = vi.fn();
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    window.history.replaceState({}, '', '/scanner/?view=local');
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, { target: { files: [new File(['{"nodes":[]}'], 'private-workflow.json')] } });

    await waitFor(() => expect(onScan).toHaveBeenCalled());
    expect(screen.queryByText('private-workflow.json')).toBeNull();
    expect(window.location.search).toBe('?view=local');
  });

  it('keeps uploaded filename and byte size out of URL, storage, and logs', async () => {
    const onScan = vi.fn();
    const filename = 'customer-credentials-private.json';
    const file = new File(['x'.repeat(777)], filename, { type: 'application/json' });
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    window.history.replaceState({}, '', '/scanner/?view=local');
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(onScan).toHaveBeenCalled());
    const logOutput = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
    expect(screen.queryByText(filename)).toBeNull();
    expect(screen.queryByText(String(file.size))).toBeNull();
    expect(window.location.href).not.toContain(filename);
    expect(window.location.href).not.toContain(String(file.size));
    expect(storageWrite).not.toHaveBeenCalled();
    expect(logOutput).not.toContain(filename);
    expect(logOutput).not.toContain(String(file.size));
  });

  it('submits local file input without making network requests', async () => {
    const onScan = vi.fn();
    const fetchMock = vi.fn();
    const xhrMock = vi.fn();
    const webSocketMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', xhrMock); // browser-safe-ignore
    vi.stubGlobal('WebSocket', webSocketMock); // browser-safe-ignore
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(['{"nodes":[]}'], 'local-only.json', { type: 'application/json' });

    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(onScan).toHaveBeenCalledWith({
      json: '{"nodes":[]}',
      profile: 'beta-default',
      approvedDomains: [],
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrMock).not.toHaveBeenCalled();
    expect(webSocketMock).not.toHaveBeenCalled();
  });

  it('exposes only the default scan profile and submits it', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);

    expect(screen.getByText('Default scan')).toBeTruthy(); // chip copy (scanner-input.tsx:134); only admitted profile id is 'beta-default' (scanner-input.tsx:8)
    expect(screen.queryByText('Standard')).toBeNull();

    fireEvent.change(screen.getByLabelText('Workflow JSON'), {
      target: { value: '{"nodes":[],"connections":{}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(onScan).toHaveBeenCalledWith({
      json: '{"nodes":[],"connections":{}}',
      profile: 'beta-default',
      approvedDomains: [],
    });
  });

  it('does not let page-global v2 mode change the submitted scan profile', () => {
    vi.stubGlobal('__SECUREFLOW_BROWSER_SCANNER_MODE__', 'v2');
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);

    fireEvent.change(screen.getByLabelText('Workflow JSON'), {
      target: { value: '{"nodes":[],"connections":{}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));

    expect(onScan).toHaveBeenCalledWith({
      json: '{"nodes":[],"connections":{}}',
      profile: 'beta-default',
      approvedDomains: [],
    });
  });

  it('does not advertise a competing Standard mode in the scanner guide', () => {
    render(<ScannerLimits />);

    expect(screen.getByText('Deep scan')).toBeTruthy();
    expect(screen.queryByText(/Standard/)).toBeNull();
    expect(screen.queryByText('Two depths')).toBeNull();
  });

  it('rejects an oversized file before constructing FileReader', () => {
    const reader = vi.fn();
    vi.stubGlobal('FileReader', reader);
    const { container } = render(<ScannerInput isScanning={false} onScan={vi.fn()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([new Uint8Array(MAX_WORKFLOW_BYTES + 1)], 'large.json');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(reader).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(`larger than ${MAX_WORKFLOW_BYTES_LABEL}`);
  });

  it('shows an actionable error when FileReader fails', () => {
    class FailingReader {
      onload: FileReader['onload'] = null;
      onerror: FileReader['onerror'] = null;
      readAsText() {
        this.onerror?.call(this as unknown as FileReader, new ProgressEvent('error') as ProgressEvent<FileReader>);
      }
    }
    vi.stubGlobal('FileReader', FailingReader);
    const onScan = vi.fn();
    const { container } = render(<ScannerInput isScanning={false} onScan={onScan} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [new File(['{}'], 'workflow.json')] } });

    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('could not read');
  });

  it('canonicalizes valid hosts and names rejected domain values', () => {
    const onScan = vi.fn();
    render(<ScannerInput isScanning={false} onScan={onScan} />);
    fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expected domains' }));
    const domains = screen.getByLabelText('Hosts you expect this workflow to contact');

    fireEvent.change(domains, {
      target: { value: 'https://API.Example.com:8443/path, münich.example, *.bad.example, /relative, https://user:pass@secret.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('*.bad.example');
    expect(screen.getByRole('alert').textContent).toContain('/relative');
    expect(screen.getByRole('alert').textContent).toContain('https://user:pass@secret.example');

    fireEvent.change(domains, {
      target: { value: 'https://API.Example.com:8443/path, münich.example, api.example.com.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    expect(onScan).toHaveBeenCalledWith(expect.objectContaining({
      approvedDomains: ['api.example.com', 'xn--mnich-kva.example'],
    }));
  });

  it('takes the large editor out of layout while scanning and exposes 44px loading targets', () => {
    render(<ScannerInput isScanning={true} onScan={vi.fn()} />);

    expect(screen.queryByLabelText('Workflow JSON')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Scanning workflow locally');
    for (const name of ['Upload .json', 'Expected domains', 'Scanning…']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.className).toContain('min-h-11');
    }
  });
});
