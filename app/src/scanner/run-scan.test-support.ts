import type { ScanWorkflowResult } from './engine';
import type { ScanWorkerRequest, ScanWorkerResponse } from './scan.worker';
import { SCANNER_RESULT_SCHEMA_VERSION } from '@hub/contracts';

export function createMockScanResult(profile: 'beta-default' | 'beta-hardened'): ScanWorkflowResult {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: 'scanner-beta-1',
    policyProfile: profile,
    analysisStatus: 'COMPLETE',
    analysisDiagnostics: [],
    workflow: {
      name: 'Test Workflow', nodeCount: 2, rawNodeCount: 2, annotationNodeCount: 0,
      triggerCount: 1, actionCount: 1, integrationCount: 0, connectionCount: 1,
      payloadBytes: 120, complexity: 'LOW', isSubWorkflow: false,
    },
    functionSummary: {
      basicPurpose: 'Test purpose', triggerDescription: 'Manual trigger',
      dataFlowSummary: 'Processes input data', businessCategory: 'MANUAL_AUTOMATION', confidence: 'HIGH',
    },
    integrations: [],
    riskAssessment: {
      grade: 'LOW', score: 0, topRisks: [], dataExposure: 'None', complexityDrivers: [],
    },
    humanSummary: {
      headline: 'Low risk workflow', verdict: 'Review this workflow before import.',
      plainLanguageOverview: 'Workflow triggers manually and processes input data.',
      riskNarrative: 'No high-risk nodes detected.', recommendedActions: ['Review parameters'],
      findingHighlights: [],
    },
    summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [],
  };
}

export class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent<ScanWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  lastScanRequest: Extract<ScanWorkerRequest, { kind: 'scan' }> | null = null;

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(msg: ScanWorkerRequest): void {
    if (this.terminated) return;
    if (msg.kind !== 'scan') return;
    const { id, json, profile } = msg;
    this.lastScanRequest = msg;
    if (json === 'HOLD_TRIGGER') return;
    if (json === 'INVALID_JSON_DATA') {
      this.queueError({ kind: 'error', id, code: 'INVALID_JSON', message: 'Workflow JSON is not valid JSON.' });
      return;
    }
    if (json.includes('TOO_LARGE_TRIGGER')) {
      this.queueError({ kind: 'error', id, code: 'TOO_LARGE', message: 'Workflow JSON exceeds the 2 MiB limit.' });
      return;
    }
    if (json.includes('TOO_MANY_NODES_WITH_DETAILS_TRIGGER')) {
      this.queueError({
        kind: 'error',
        id,
        code: 'TOO_MANY_NODES',
        message: 'Workflow exceeds the 5,000-node limit.',
        details: { observedNodeCount: 7000 },
      });
      return;
    }
    if (json.includes('TOO_MANY_NODES_TRIGGER')) {
      this.queueError({ kind: 'error', id, code: 'TOO_MANY_NODES', message: 'Workflow exceeds the 5,000-node limit.' });
      return;
    }
    if (json === 'REGRESSING_PROGRESS_TRIGGER') {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.emit({ kind: 'progress', id, phase: 'analyse', pct: 60 });
        this.emit({ kind: 'progress', id, phase: 'parse', pct: 25 });
        this.emit({ kind: 'result', id, result: createMockScanResult(profile) });
      });
      return;
    }
    if (json === 'WORKER_CRASH_TRIGGER') {
      queueMicrotask(() => {
        if (!this.terminated) this.onerror?.({ message: 'worker crashed' } as ErrorEvent);
      });
      return;
    }
    if (json === 'MESSAGE_ERROR_TRIGGER') {
      queueMicrotask(() => {
        if (!this.terminated) this.onmessageerror?.({ data: null } as MessageEvent);
      });
      return;
    }
    if (json === 'MALFORMED_RESULT_TRIGGER') {
      queueMicrotask(() => {
        if (!this.terminated) this.emit({ kind: 'result', id, result: {} as ScanWorkflowResult });
      });
      return;
    }
    if (json === 'UNKNOWN_RESPONSE_TRIGGER') {
      queueMicrotask(() => {
        if (!this.terminated) {
          this.emit({ kind: 'unexpected', id } as unknown as ScanWorkerResponse);
        }
      });
      return;
    }

    queueMicrotask(() => {
      if (this.terminated) return;
      this.emit({ kind: 'progress', id, phase: 'parse', pct: 25 });
      this.emit({ kind: 'progress', id, phase: 'analyse', pct: 60 });
      this.emit({ kind: 'progress', id, phase: 'render', pct: 90 });
      this.emit({ kind: 'result', id, result: createMockScanResult(profile) });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private queueError(response: ScanWorkerResponse): void {
    queueMicrotask(() => {
      if (!this.terminated) this.emit(response);
    });
  }

  private emit(response: ScanWorkerResponse): void {
    if (!this.terminated && this.onmessage) {
      this.onmessage({ data: response } as MessageEvent<ScanWorkerResponse>);
    }
  }
}
