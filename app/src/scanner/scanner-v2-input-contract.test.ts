// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scannerCoreV2 from '@hub/scanner-core/v2';
import { SAFE_SAMPLE_WORKFLOW } from './safe-sample-workflow';
import type { ScanWorkerRequest, ScanWorkerResponse } from './scan.worker';
/**
 * Frozen enumerator of what the scanner UI actually collects, read off the UI source:
 * `scanner-input.tsx:9` (`ScanRequest`), `:39` (`jsonText`), `:40` (`domainsText`),
 * `:76` (`parseApprovedDomains`), `:84` (the fixed `profile: 'beta-default'`).
 *
 * Reviewer: verify this list against `scanner-input.tsx`, never against this file or the adapter.
 * `json` is the workflow document the brief calls `workflows`; the name the UI collects under is
 * the one the contract has to carry.
 */
const UI_COLLECTED = ['json', 'approvedDomains', 'profile'] as const;
/**
 * Fields the UI collects and the product deliberately discards. An entry requires a user-visible
 * notice naming the field plus its justification, and neither exists today — so this is empty.
 */
const DROPPED_WITH_NOTICE: readonly string[] = [];
/** One v2 scan as the UI submits it, with a non-empty allowlist so the adapter cannot elide it. */
const UI_REQUEST = Object.freeze({
  json: SAFE_SAMPLE_WORKFLOW,
  profile: 'beta-default' as const,
  approvedDomains: Object.freeze(['api.trusted.example']),
});

type UiRequest = typeof UI_REQUEST;
type PlainRecord = Record<string, unknown>;
/** What the v2 path actually delivered for one UI request, boundary by boundary. */
type V2PathObservation = Readonly<{
  ui: typeof UI_REQUEST;
  /** The exact `scan-v2` payload the adapter posted to the worker (layers 2–4). */
  adapterPayload: unknown;
  /** The request object the worker handed `scanWorkflowV2` (layers 5–7). */
  engineRequest: unknown;
  workerResponse: ScanWorkerResponse | undefined;
}>;

function plainRecord(value: unknown): PlainRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? (value as PlainRecord)
    : undefined;
}
/** Same members whatever the order: the engine may canonicalise the allowlist it receives. */
function sameMembers(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

/** Finds `match` anywhere in the engine request, so a value delivered under a new key still counts. */
function carriesValue(node: unknown, match: (value: unknown) => boolean, depth = 0): boolean {
  if (depth > 8) return false;
  if (match(node)) return true;
  if (Array.isArray(node)) return node.some((item) => carriesValue(item, match, depth + 1));
  const record = plainRecord(node);
  return record !== undefined && Object.values(record).some((value) => carriesValue(value, match, depth + 1));
}

/**
 * Does `name`'s collected value arrive at the engine?
 *
 * Value-based on purpose. Comparing key names against `BrowserScanRequestV2` is the check that goes
 * green while the allowlist is discarded (audit F-003), and a value the engine receives under a
 * different name — `json` arrives as the `bytes` the engine consumes — is delivered, not dropped.
 * An undeclared name has no arrival route and is a drop until proven otherwise.
 */
function arrivesAtEngine(name: string, observation: V2PathObservation): boolean {
  const { ui, adapterPayload, engineRequest } = observation;
  const posted = plainRecord(adapterPayload);
  switch (name) {
    case 'json': {
      const bytes = plainRecord(engineRequest)?.bytes;
      return posted?.json === ui.json && bytes instanceof Uint8Array && new TextDecoder().decode(bytes) === ui.json;
    }
    case 'profile':
      return posted?.profile === ui.profile && carriesValue(engineRequest, (value) => value === ui.profile);
    case 'approvedDomains':
      return sameMembers(posted?.approvedDomains, ui.approvedDomains)
        && carriesValue(engineRequest, (value) => sameMembers(value, ui.approvedDomains));
    default:
      return false;
  }
}

/** Names the UI collects that reach neither `BrowserScanRequestV2` nor the scan engine. */
function findSilentDrops(uiCollected: readonly string[], droppedWithNotice: readonly string[], observation: V2PathObservation): string[] {
  const noticed = new Set(droppedWithNotice);
  return uiCollected.filter((name) => !noticed.has(name) && !arrivesAtEngine(name, observation));
}

type MessageListener = (event: MessageEvent<ScanWorkerRequest>) => void;

let capturedAdapterPayload: unknown = null;
let capturedWorkerResponse: ScanWorkerResponse | undefined;
const listeners: MessageListener[] = [];
const engineRequests: unknown[] = [];

/** Posts back a genuine v2 result so the adapter run resolves; captures what the browser sent. */
class CapturingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage(message: ScanWorkerRequest): void {
    capturedAdapterPayload = message;
    queueMicrotask(() => {
      const result = scannerCoreV2.scanWorkflowV2({ bytes: new TextEncoder().encode(message.json), profile: { id: 'beta-default', version: '2.0.0' } });
      if (!result.ok) return;
      this.onmessage?.({ data: { kind: 'result-v2', id: message.id, result: result.result } } as MessageEvent);
    });
  }

  terminate(): void {}
}

/**
 * Drives the real path the browser takes, one layer at a time:
 * UI shape → `runBrowserScanV2` (capturing the worker payload) → real `scan.worker` listener
 * (with `scanWorkflowV2` recorded) → engine.
 */
async function observeV2Path(ui: UiRequest = UI_REQUEST): Promise<V2PathObservation> {
  // Both imports below are dynamic on purpose: each module must be evaluated *after* the globals it
  // reads at import time are stubbed (the adapter's `Worker`, the worker's `addEventListener`), and
  // the registry is reset between them so the adapter and the worker each load once, stubbed.
  vi.resetModules();
  vi.stubGlobal('Worker', CapturingWorker);
  const { runBrowserScanV2 } = await import('./scanner-v2-adapter');
  const outcome = await runBrowserScanV2({ ...ui, approvedDomains: [...ui.approvedDomains] });
  expect(outcome.ok).toBe(true);
  const adapterPayload = capturedAdapterPayload;

  vi.resetModules();
  vi.doMock('@hub/scanner-core/v2', async (importOriginal) => {
    const actual = await importOriginal<typeof scannerCoreV2>();
    return {
      ...actual,
      scanWorkflowV2: (input: unknown) => {
        engineRequests.push(input);
        return actual.scanWorkflowV2(input);
      },
    };
  });
  vi.stubGlobal('addEventListener', (type: string, listener: MessageListener) => {
    if (type === 'message') listeners.push(listener);
  });
  vi.stubGlobal('postMessage', (message: ScanWorkerResponse) => {
    capturedWorkerResponse = message;
  });
  await import('./scan.worker');
  for (const listener of listeners) listener({ data: adapterPayload } as MessageEvent<ScanWorkerRequest>);

  return { ui, adapterPayload, engineRequest: engineRequests.at(-1), workerResponse: capturedWorkerResponse };
}

beforeEach(() => {
  capturedAdapterPayload = null;
  capturedWorkerResponse = undefined;
  listeners.length = 0;
  engineRequests.length = 0;
});

afterEach(() => {
  vi.doUnmock('@hub/scanner-core/v2');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('v2 dropped-input contract (audit F-003)', () => {
  it('no UI-collected input is silently dropped', async () => {
    const observation = await observeV2Path();

    // The allowlist survives the UI, the adapter and the worker's request validation...
    expect(observation.adapterPayload).toMatchObject({ approvedDomains: [...UI_REQUEST.approvedDomains] });
    // ...and the scan still reports success, which is what makes the drop silent rather than loud.
    expect(observation.workerResponse).toMatchObject({ kind: 'result-v2' });

    expect(findSilentDrops(UI_COLLECTED, DROPPED_WITH_NOTICE, observation)).toEqual([]);
  });
  it('reports a UI-collected field with no declared arrival route', async () => {
    const observation = await observeV2Path();

    // Deliberately omits `approvedDomains`: this test is about the enumerator failing closed for an
    // unknown name, not about F-003, and it must not go green or red with the defect.
    expect(findSilentDrops(['json', 'profile', 'unroutedInput'], DROPPED_WITH_NOTICE, observation)).toEqual(['unroutedInput']);
  });
  it('sees the allowlist once the engine request carries it', async () => {
    const observation = await observeV2Path();

    // Sensitivity control on the checker, not evidence about production: it proves a delivered
    // allowlist is recognised under a nested key too, so the RED above cannot be unsatisfiable.
    const engineRequest = { ...plainRecord(observation.engineRequest), configuration: [...UI_REQUEST.approvedDomains] };
    expect(findSilentDrops(UI_COLLECTED, DROPPED_WITH_NOTICE, { ...observation, engineRequest })).toEqual([]);
  });
});

/** Documented request shape (`docs/scanner/contracts-v2.md`): `bytes, profile, target?, limits?,
 *  approvedDomains?`, closed, with an empty allowlist treated as absent. The UI owns the profile
 *  name; the engine owns its version. */
const DOCUMENTED_REQUEST_ORDER = ['bytes', 'profile', 'target', 'limits', 'approvedDomains'] as const;

function resultRuleIds(response: ScanWorkerResponse | undefined): string[] {
  if (response?.kind !== 'result-v2') throw new Error(`Expected a result-v2 response, got ${response?.kind ?? 'none'}`);
  return response.result.findings.map(({ ruleId }) => ruleId);
}

describe('v2 request order, encoding and profile ownership', () => {
  /** Mutations caught: the allowlist carried out of documented order, and text normalised, trimmed
   *  or re-encoded on the way in (this JSON's astral and CJK characters make its UTF-8 length
   *  differ from `json.length`). */
  it('delivers the expected-domains input last, with the text byte-identical', async () => {
    const unicodeText = JSON.stringify({ name: '🙂 pipeline 安全', nodes: [{ id: 'h1', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { apiKey: 'sk_live_super_secret_value', note: 'é安全' } }], connections: {} });
    const observation = await observeV2Path({ json: unicodeText, profile: 'beta-default', approvedDomains: ['api.trusted.example'] });
    const engineRequest = plainRecord(observation.engineRequest);
    if (!engineRequest) throw new Error('Expected an engine request');
    const members = Object.keys(engineRequest);
    expect(members).toEqual([...DOCUMENTED_REQUEST_ORDER].filter((member) => members.includes(member)));
    expect(members.at(-1)).toBe('approvedDomains');
    const bytes = engineRequest.bytes;
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected the engine request to carry UTF-8 bytes');
    expect(new TextDecoder().decode(bytes)).toBe(unicodeText);
    expect(bytes.byteLength).toBe(new TextEncoder().encode(unicodeText).length);
    expect(bytes.byteLength).toBeGreaterThan(unicodeText.length);
    expect(observation.workerResponse).toMatchObject({ kind: 'result-v2', result: { input: { utf8Bytes: bytes.byteLength } } });
  });

  /** Mutations caught: a profile version travelling from the UI (the worker's closed-record check
   *  refuses the request, so no result comes back), and a worker substituting an unadmitted profile
   *  (the engine answers `PROFILE_NOT_ADMITTED`, so no result comes back). */
  it('carries the UI profile name while the engine owns the version', async () => {
    const observation = await observeV2Path();
    const engineRequest = plainRecord(observation.engineRequest);
    const engineProfile = plainRecord(engineRequest?.profile);
    expect(plainRecord(observation.adapterPayload)?.profile).toBe(UI_REQUEST.profile);
    expect(engineProfile).toEqual({ id: UI_REQUEST.profile, version: '2.0.0' });
    expect(Object.keys(engineProfile ?? {})).toEqual(['id', 'version']);
    expect(observation.workerResponse).toMatchObject({ kind: 'result-v2', result: { profile: { id: UI_REQUEST.profile, version: '2.0.0' } } });
  });

  /** Mutation caught: an empty expected-domains list enabling the policy, which would report the
   *  destination as unapproved instead of leaving the check off. */
  it('keeps the unexpected-destination check off for an empty expected-domains input', async () => {
    const external = JSON.stringify({ nodes: [{ id: 'h1', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://unapproved.example/v1' } }], connections: {} });
    const listed = await observeV2Path({ json: external, profile: 'beta-default', approvedDomains: ['api.trusted.example'] });
    const unlisted = await observeV2Path({ json: external, profile: 'beta-default', approvedDomains: [] });
    expect(resultRuleIds(listed.workerResponse)).toContain('UNAPPROVED_DOMAIN');
    expect(resultRuleIds(unlisted.workerResponse)).not.toContain('UNAPPROVED_DOMAIN');
    expect(plainRecord(unlisted.adapterPayload)).not.toHaveProperty('approvedDomains');
  });
});
