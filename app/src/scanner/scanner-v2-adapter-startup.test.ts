// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { V2_ADAPTER_PROFILE } from '@hub/scanner-core/test/v2-adapter-fixtures';

const clean = '{"nodes":[],"connections":{}}';
let prepareBrowserScanV2: typeof import('./scanner-v2-adapter')['prepareBrowserScanV2'];
let runBrowserScanV2: typeof import('./scanner-v2-adapter')['runBrowserScanV2'];

class StartupWorker {
  static instances: StartupWorker[] = [];
  static failFirstConstruction = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Array<{ kind: string; id: string; json?: string }> = [];
  terminated = false;

  constructor() {
    if (StartupWorker.failFirstConstruction) {
      StartupWorker.failFirstConstruction = false;
      throw new Error('startup construction failed');
    }
    StartupWorker.instances.push(this);
  }

  postMessage(message: { kind: string; id: string; json?: string }): void {
    this.messages.push(message);
    if (message.kind !== 'scan-v2' || !message.json) return;
    const outcome = scanWorkflowV2({
      bytes: new TextEncoder().encode(message.json),
      profile: V2_ADAPTER_PROFILE,
    });
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({
        data: outcome.ok
          ? { kind: 'result-v2', id: message.id, result: outcome.result }
          : { kind: 'error-v2', id: message.id, code: outcome.code, message: outcome.message },
      } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(async () => {
  StartupWorker.instances = [];
  StartupWorker.failFirstConstruction = false;
  vi.stubGlobal('Worker', StartupWorker);
  vi.resetModules();
  ({ prepareBrowserScanV2, runBrowserScanV2 } = await import('./scanner-v2-adapter'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser scanner worker startup', () => {
  it('constructs one real worker without starting an analysis', () => {
    prepareBrowserScanV2();

    expect(StartupWorker.instances).toHaveLength(1);
    expect(StartupWorker.instances[0]!.messages).toEqual([]);
  });

  it('reports one asynchronous startup failure before retrying with a fresh worker', async () => {
    prepareBrowserScanV2();
    const failed = StartupWorker.instances[0]!;
    failed.onerror?.();

    await expect(runBrowserScanV2({
      json: clean,
      profile: 'beta-default',
      approvedDomains: [],
    })).resolves.toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'Scanner worker failed.',
    });
    expect(failed.terminated).toBe(true);

    await expect(runBrowserScanV2({
      json: clean,
      profile: 'beta-default',
      approvedDomains: [],
    })).resolves.toMatchObject({ ok: true });
    expect(StartupWorker.instances).toHaveLength(2);
  });

  it('reports one construction failure before retrying with a fresh worker', async () => {
    StartupWorker.failFirstConstruction = true;
    expect(() => prepareBrowserScanV2()).not.toThrow();

    await expect(runBrowserScanV2({
      json: clean,
      profile: 'beta-default',
      approvedDomains: [],
    })).resolves.toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'Scanner worker failed to start.',
    });

    await expect(runBrowserScanV2({
      json: clean,
      profile: 'beta-default',
      approvedDomains: [],
    })).resolves.toMatchObject({ ok: true });
    expect(StartupWorker.instances).toHaveLength(1);
  });
});
