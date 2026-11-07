// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCANNER_LIMITS, DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalJsonBytes } from '@hub/scanner-core/canonical-json';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '@hub/scanner-core/test/v2-adapter-fixtures';
import { runBrowserScanV2 } from './scanner-v2-adapter';

type WorkerMessage = { kind: string; id: string; json?: string; profile?: string };

class FakeWorker {
  static hold = false;
  static craftedV2Result: unknown = null;
  static capture: ((result: unknown) => void) | null = null;
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  lastRequest: WorkerMessage | null = null;

  constructor() { FakeWorker.instances.push(this); }

  postMessage(message: WorkerMessage): void {
    this.lastRequest = message;
    if (FakeWorker.hold || message.kind !== 'scan-v2' || !message.json) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: { kind: 'progress', id: message.id, phase: 'parse', pct: 25 } } as MessageEvent);
      if (FakeWorker.craftedV2Result) {
        this.onmessage?.({ data: { kind: 'result-v2', id: message.id, result: FakeWorker.craftedV2Result } } as MessageEvent);
        return;
      }
      const result = scanWorkflowV2({ bytes: new TextEncoder().encode(message.json!), profile: { id: 'beta-default', version: '2.0.0' } });
      if (result.ok) {
        FakeWorker.capture?.(result.result);
        this.onmessage?.({ data: { kind: 'progress', id: message.id, phase: 'analyse', pct: 60 } } as MessageEvent);
        this.onmessage?.({ data: { kind: 'progress', id: message.id, phase: 'render', pct: 90 } } as MessageEvent);
        this.onmessage?.({ data: { kind: 'result-v2', id: message.id, result: result.result } } as MessageEvent);
      } else {
        this.onmessage?.({ data: { kind: 'error-v2', id: message.id, code: result.code, message: result.message } } as MessageEvent);
      }
    });
  }

  terminate(): void { this.terminated = true; }
}

const clean = '{"nodes":[],"connections":{}}';
const risky = JSON.stringify({ nodes: [{ id: 'command', name: 'Run', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: 'echo hello' } }], connections: {} });
// A readable unmodelled node grades DEGRADED under the labelled fallback
// (ADR-generic-node-semantic-fallback §2), so the level that withholds the verdict is the node the
// scanner refuses to read: a non-object `parameters` member (ADR §4, unreadable node fields).
const indeterminate = JSON.stringify({ nodes: [{ id: 'custom', name: 'Custom', type: '@example/custom-node.unknown', parameters: 'not-an-object' }], connections: {} });
const workerFor = (): FakeWorker => FakeWorker.instances.at(-1)!;
const v2 = (json: string) => {
  const result = scanWorkflowV2({ bytes: new TextEncoder().encode(json), profile: V2_ADAPTER_PROFILE });
  if (!result.ok) throw new Error(result.message);
  return result.result;
};

beforeEach(() => {
  // The singleton worker stays visible so cancellation can verify termination.
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.hold = false;
  FakeWorker.craftedV2Result = null;
  FakeWorker.capture = null;
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('runBrowserScanV2', () => {
  /** The envelope the report renders, field by field, from the path the client drives (B4a mapping
   *  table). Mutations caught: a reshaped envelope (limits.usage emptied, assessment nulled, facts
   *  or span dropped) while the scan succeeded, and any clock/random source on the scan path. */
  it('projects the result-v2 envelope from a pasted workflow, field by field', async () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network'); });
    const progress: number[] = [];
    const outcome = await runBrowserScanV2({ json: risky, profile: 'beta-default', approvedDomains: [], onProgress: (_phase, pct) => progress.push(pct) });
    expect(progress).toEqual([25, 60, 90]);
    // No network, clock or random source is consulted on the scan path.
    expect([fetch, clock, random].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { result } = outcome;
    // Status and verdict: analysis.status, assessment.
    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.assessment).not.toBeNull();
    // Coverage rows: profile, analysis.capabilities, limits.usage, stats.
    expect(result.profile).toEqual({ id: 'beta-default', version: '2.0.0' });
    expect(result.analysis.capabilities.map(({ id }) => id)).toEqual(['source-normalization', 'workflow-insights', 'structural-policies', 'assessment', 'presentation-facts']);
    expect(result.analysis.capabilities.every(({ required }) => required)).toBe(true);
    expect(result.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans')).toMatchObject({ omitted: 0, exhausted: false });
    expect(result.stats.omittedFindings).toBe(0);
    // Applicability: per-finding applicability, and the target context it is qualified against.
    expect(result.target.edition).toBe('UNKNOWN');
    expect(result.findings.every(({ applicability }) => ['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'].includes(applicability))).toBe(true);
    // Evidence, traces and source coordinates: facts, traces, and the finding subject's own span.
    expect(result.facts.length).toBeGreaterThan(0);
    expect(Array.isArray(result.traces)).toBe(true);
    const subject = result.findings.find(({ subject: candidate }) => candidate.kind === 'NODE')?.subject;
    expect(subject?.kind === 'NODE' ? subject.node.source.span : null).toMatchObject({ start: { line: 1 } });
    // Redaction: the envelope reaching the report carries no source payload.
    expect(JSON.stringify(result)).not.toContain('echo hello');
  });
  it('maps every input failure to a closed code and no envelope', async () => {
    const cases = [
      { json: '{"nodes":', code: 'INVALID_JSON' },
      { json: JSON.stringify({ nodes: Array.from({ length: DEFAULT_SCANNER_LIMITS_V2.maxNodes + 1 }, (_, index) => ({ id: `n${index}`, name: `Node ${index}`, type: 'n8n-nodes-base.manualTrigger' })), connections: {} }), code: 'WORKFLOW_TOO_COMPLEX' },
    ];
    for (const { json, code } of cases) {
      const outcome = await runBrowserScanV2({ json, profile: 'beta-default', approvedDomains: [] });
      // A failure resolves with no `result` member at all: there is no envelope a verdict could be
      // rendered from (mutation: a failure resolved with an empty or placeholder result).
      expect(outcome).toEqual({ ok: false, code, message: `Scanner v2 worker rejected the scan (${code}).` });
      expect(outcome).not.toHaveProperty('result');
    }

    // The over-byte document never reaches the worker: it is refused before the
    // string is structured-cloned, so its message names the limit, not a handshake.
    const oversized = await runBrowserScanV2({
      json: `{"data":"${'x'.repeat(DEFAULT_SCANNER_LIMITS_V2.maxBytes)}"}`,
      profile: 'beta-default',
      approvedDomains: [],
    });
    expect(oversized).toEqual({
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
      message: `Workflow JSON exceeds the ${DEFAULT_SCANNER_LIMITS.maxBytes}-byte payload limit.`,
    });
    expect(oversized).not.toHaveProperty('result');
  });
  it('rejects oversized text before constructing a worker and does not cancel a live run', async () => {
    FakeWorker.hold = true;
    const controller = new AbortController();
    const live = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [], signal: controller.signal });
    const activeWorker = workerFor();
    const before = FakeWorker.instances.length;

    await expect(runBrowserScanV2({
      json: 'x'.repeat(DEFAULT_SCANNER_LIMITS.maxBytes + 1), profile: 'beta-default', approvedDomains: [],
    })).resolves.toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });

    expect(FakeWorker.instances.length).toBe(before);
    expect(activeWorker.terminated).toBe(false);

    controller.abort();
    await expect(live).resolves.toMatchObject({ ok: false, code: 'SCAN_CANCELLED' });
  });

  it('preserves indeterminate results and leaves the surface ready after cancellation', async () => {
    const uncertain = await runBrowserScanV2({ json: indeterminate, profile: 'beta-default', approvedDomains: [] });
    // An indeterminate envelope withholds the verdict: no assessment, so no grade can be rendered.
    expect(uncertain).toMatchObject({ ok: true, result: { analysis: { status: 'INDETERMINATE' }, assessment: null } });

    FakeWorker.hold = true;
    const controller = new AbortController();
    const pending = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [], signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'SCAN_CANCELLED' });
    expect(workerFor().terminated).toBe(true);

    // Cancellation leaves the surface ready: a cached terminated worker would never answer again.
    FakeWorker.hold = false;
    await expect(runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] })).resolves.toMatchObject({ ok: true });
  });

  /** Mutations caught: a response or progress frame accepted for whatever id it carries, and a
   *  progress frame outside 0..100 or behind the high-water mark forwarded to the caller's bar. */
  it('accepts a foreign id neither as a result nor as progress', async () => {
    FakeWorker.hold = true;
    const frames: number[] = [];
    const controller = new AbortController();
    const pending = runBrowserScanV2({ json: risky, profile: 'beta-default', approvedDomains: [], signal: controller.signal, onProgress: (_phase, pct) => frames.push(pct) });
    const worker = workerFor();
    const id = worker.lastRequest!.id;
    const post = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    post({ kind: 'progress', id: 'browser-v2-other', phase: 'render', pct: 90 });
    post({ kind: 'progress', id, phase: 'parse', pct: 101 });
    post({ kind: 'progress', id, phase: 'parse', pct: 95 });
    post({ kind: 'progress', id, phase: 'parse', pct: 40 });
    post({ kind: 'result-v2', id: 'browser-v2-other', result: v2(clean) });

    await Promise.resolve();
    expect(settled).toBe(false);
    // Only the frame above every earlier high-water mark and inside 0..100 reaches the bar.
    expect(frames).toEqual([95]);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'SCAN_CANCELLED' });
  });

  /** Mutations caught: `lastProgress` unconsumed by the first scan filtering the second scan's
   *  25/60 frames, and a repeated upload answered from a cached result. */
  it('starts a repeated upload from a clean surface with its own result', async () => {
    const firstFrames: number[] = [];
    const secondFrames: number[] = [];
    const first = await runBrowserScanV2({ json: risky, profile: 'beta-default', approvedDomains: [], onProgress: (_phase, pct) => firstFrames.push(pct) });
    const second = await runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [], onProgress: (_phase, pct) => secondFrames.push(pct) });

    expect(firstFrames).toEqual([25, 60, 90]);
    expect(secondFrames).toEqual([25, 60, 90]);
    if (!first.ok || !second.ok) throw new Error('Expected both scans to resolve with a result');
    expect(first.result.workflow.nodeCount).toBe(1);
    expect(second.result.workflow.nodeCount).toBe(0);
    expect(first.result.input.rawSha256).not.toBe(second.result.input.rawSha256);
  });
  it('rejects malformed worker protocol data without exposing raw exceptions', async () => {
    FakeWorker.hold = true;
    const pending = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] });
    const worker = workerFor();
    worker.onmessage?.({ data: null } as MessageEvent);
    await expect(pending).resolves.toEqual({ ok: false, code: 'INTERNAL', message: 'Scanner worker returned an invalid v2 response.' });
    expect(worker.terminated).toBe(true);
  });
  it('refuses a worker result whose counters contradict its completeness claim', async () => {
    const baseline = v2(clean);
    // A host that trusted the aggregate alone would publish a completeness claim these counters deny.
    FakeWorker.craftedV2Result = { ...baseline, analysis: { status: 'COMPLETE', capabilities: [{ id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED', seen: 3, analyzed: 1, skipped: 2, omitted: 0, diagnosticIds: [] }], diagnostics: [] } };
    await expect(runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] })).resolves.toEqual({ ok: false, code: 'INVALID_RESULT', message: 'Scanner worker returned a malformed v2 result.' });
    expect(workerFor().terminated).toBe(true);

    // The counters the analyzers actually publish - one seen node, one analyzed source, one recorded
    // omission - are legitimate and reach the host unchanged.
    FakeWorker.craftedV2Result = { ...baseline, analysis: { status: 'DEGRADED', capabilities: [{ id: 'expression-security', version: '2.0.0', required: false, status: 'DEGRADED', seen: 1, analyzed: 1, skipped: 0, omitted: 1, diagnosticIds: [] }], diagnostics: [] } };
    const accepted = await runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] });
    expect(accepted).toMatchObject({ ok: true, result: { analysis: { status: 'DEGRADED', capabilities: [{ id: 'expression-security', seen: 1, analyzed: 1, skipped: 0, omitted: 1 }] } } });
  });

  it('ignores stale responses from a replaced worker', async () => {
    FakeWorker.hold = true;
    const first = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] });
    const firstWorker = workerFor();
    const firstId = firstWorker.lastRequest!.id;

    FakeWorker.hold = false;
    const second = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] });
    firstWorker.onmessage?.({ data: { kind: 'result-v2', id: firstId, result: {} } } as MessageEvent);

    await expect(first).resolves.toMatchObject({ ok: false, code: 'SCAN_CANCELLED' });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(firstWorker.terminated).toBe(true);
    expect(workerFor()).not.toBe(firstWorker);
  });

  it('terminates on deadline and retries with a fresh worker', async () => {
    vi.useFakeTimers();
    try {
      FakeWorker.hold = true;
      const pending = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [], deadlineMs: 100 });
      const timedOutWorker = workerFor();
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT', message: 'Scan exceeded the 100ms worker deadline.' });
      expect(timedOutWorker.terminated).toBe(true);

      FakeWorker.hold = false;
      await expect(runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [] })).resolves.toMatchObject({ ok: true });
      expect(workerFor()).not.toBe(timedOutWorker);
    } finally {
      vi.useRealTimers();
    }
  });
  it('ignores a result frame the killed worker delivers after the deadline', async () => {
    vi.useFakeTimers();
    try {
      FakeWorker.hold = true;
      const pending = runBrowserScanV2({ json: clean, profile: 'beta-default', approvedDomains: [], deadlineMs: 100 });
      const timedOutWorker = workerFor();
      const id = timedOutWorker.lastRequest!.id;
      const instancesBefore = FakeWorker.instances.length;
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' });

      // The engine finished anyway. A host that adopted this frame would publish
      // a verdict from a worker it killed, so the promise stays TIMEOUT.
      timedOutWorker.onmessage?.({ data: { kind: 'result-v2', id, result: v2(clean) } } as MessageEvent);
      await vi.advanceTimersByTimeAsync(0);

      expect(timedOutWorker.terminated).toBe(true);
      expect(FakeWorker.instances.length).toBe(instancesBefore);
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures raw Worker results for byte-level parity before host projection', async () => {
    const fixture = V2_ADAPTER_FIXTURE_MATRIX.find(({ id }) => id === 'unicode-bom-workflow')!;
    const captured: unknown[] = [];
    FakeWorker.capture = (result) => captured.push(result);
    const expected = scanWorkflowV2({ bytes: new TextEncoder().encode(fixture.json), profile: V2_ADAPTER_PROFILE });
    const outcome = await runBrowserScanV2({ json: fixture.json, profile: V2_ADAPTER_PROFILE.id, approvedDomains: [] });
    expect(expected.ok).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(captured).toHaveLength(1);
    if (expected.ok && outcome.ok) {
      expect(canonicalJsonBytes(captured[0])).toEqual(canonicalJsonBytes(expected.result));
      expect(canonicalJsonBytes(outcome.result)).toEqual(canonicalJsonBytes(expected.result));
    }
  });
});
