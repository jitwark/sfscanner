import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScannerClient } from './scanner-client';

type WorkerMessage = { kind: string; id: string };

/** Never answers, so a run stays in flight until the UI cancels it. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  lastRequest: WorkerMessage | null = null;

  constructor() { FakeWorker.instances.push(this); }

  postMessage(message: WorkerMessage): void { this.lastRequest = message; }

  terminate(): void { this.terminated = true; }
}

function startScan(): void {
  fireEvent.change(screen.getByLabelText('Workflow JSON'), { target: { value: '{"nodes":[],"connections":{}}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * These run the real run-scan → scanner-v2-adapter path (no module mock), because
 * only that path can show what the Worker itself does when the user cancels.
 */
describe('ScannerClient during a real in-flight run', () => {
  it('terminates the running worker on cancel and leaves the scanner usable again', () => {
    render(<ScannerClient />);
    startScan();

    const worker = FakeWorker.instances[0]!;
    expect(worker.lastRequest?.kind).toBe('scan-v2');
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));

    expect(worker.terminated).toBe(true); // terminated, not merely hidden
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByLabelText('Workflow JSON')).toBeTruthy(); // editor is back
    expect(document.activeElement).toBe(screen.getByLabelText('Workflow JSON'));
    expect((screen.getByRole('button', { name: 'Scan workflow' }) as HTMLButtonElement).disabled).toBe(false);

    // A terminated worker is never reused: the next run builds a fresh instance.
    fireEvent.click(screen.getByRole('button', { name: 'Scan workflow' }));
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.terminated).toBe(false);
  });

  it('ticks the elapsed timer off the injected clock while the run is in flight', () => {
    vi.useFakeTimers();
    let clock = 5_000;
    render(<ScannerClient now={() => clock} />);
    startScan();

    expect(screen.getByRole('timer').textContent).toBe('0:00');

    clock += 3_000;
    act(() => { vi.advanceTimersByTime(1_000); });

    // A 30s deep scan has to look alive, not frozen.
    expect(screen.getByRole('timer').textContent).toBe('0:03');
    expect(screen.getByRole('status', { name: 'Scan status' }).textContent).toBe('Reading workflow JSON…');
  });
});
