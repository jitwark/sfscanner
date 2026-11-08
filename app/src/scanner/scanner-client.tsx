'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { AlertCircle, RotateCcw } from 'lucide-react';
import type { ScanWorkflowResult } from './engine';
import { MAX_WORKFLOW_BYTES_LABEL } from './scanner-input-validation';
import { runScanV2, ScanError } from './run-scan';
import { prepareScannerRuntime } from './scanner-runtime-bootstrap';
import type { ScanErrorCode } from './scan.worker';
import type { ScanErrorDetails } from './scan-worker-error-mapping';
import { ScannerInput, type ScanRequest } from './scanner-input';
import { PENDING_PHASE_LABEL, PHASE_LABELS, ScanProgress } from './scan-progress';
import { ReportLoading } from './report/report-loading';
import { createPrerequisiteSidecar, type ReportPrerequisitesModel } from './prerequisite-sidecar';

type ScannerErrorCode = ScanErrorCode | 'V2_FAILURE' | 'V2_TOO_COMPLEX';

const ReportResult = dynamic(
  () => import('./report/report-result').then((module) => module.ReportResult),
  {
    ssr: false,
    loading: () => <ReportLoading />,
  },
);

prepareScannerRuntime();

/**
 * One entry per `ScanErrorCode`. A `WORKFLOW_TOO_COMPLEX` rejection from the
 * parser can have several distinct causes (AUDIT-SCAN-003) — node count, edge
 * count, connection nesting, parameter complexity, source document depth, and duplicate-key pointer output size —
 * each mapped to its own code upstream from the parser's typed `cause` field (see
 * scan-worker-error-mapping.ts) so this table can name the real limit instead
 * of defaulting every rejection to "over 5,000 nodes". Functions take the
 * worker-supplied `details` so a genuinely known observed value (currently:
 * node count only) can be named; anything not safely known falls back to
 * naming just the limit.
 */
const ERROR_MESSAGES: Record<ScannerErrorCode, (details?: ScanErrorDetails) => string> = {
  TOO_LARGE: () => `This workflow is over the ${MAX_WORKFLOW_BYTES_LABEL} in-browser limit. Export and scan one workflow at a time.`,
  TOO_MANY_NODES: (details) => {
    const maxNodes = DEFAULT_SCANNER_LIMITS.maxNodes.toLocaleString('en-US');
    const observed = details?.observedNodeCount;
    return observed !== undefined
      ? `This workflow has ${observed.toLocaleString('en-US')} nodes, over the ${maxNodes}-node local scanner limit. Check whether the file contains multiple workflows.`
      : `This workflow has more than ${maxNodes} nodes. Check whether the file contains multiple workflows.`;
  },
  TOO_MANY_EDGES: () => `This workflow has more connections between nodes than the ${DEFAULT_SCANNER_LIMITS.maxEdges.toLocaleString('en-US')}-connection local scanner limit. Simplify the workflow's connections, or split it into smaller workflows.`,
  CONNECTIONS_TOO_DEEP: () => `This workflow's connections are nested deeper than the ${DEFAULT_SCANNER_LIMITS.maxConnectionDepth}-level local scanner limit. This usually means the connections structure is malformed — try re-exporting the workflow from n8n.`,
  PARAMETERS_TOO_COMPLEX: () => `One or more nodes in this workflow have parameters that are larger or more deeply nested than the local scanner supports (over ${DEFAULT_SCANNER_LIMITS.maxParameterDepth} levels deep, or over ${DEFAULT_SCANNER_LIMITS.maxParameterLeaves.toLocaleString('en-US')} values). Simplify that node's configuration — for example, split large expressions or code blocks.`,
  DOCUMENT_TOO_DEEP: () => 'This workflow\'s JSON nesting exceeds the browser scanner\'s 512-level parser safety limit. Reduce the nested structure in the export and scan it again.',
  DUPLICATE_LOCATIONS_TOO_COMPLEX: () => 'This workflow has duplicate JSON keys whose source locations exceed the browser scanner\'s safe output limit. Simplify the duplicates or nested structure and scan it again.',
  INVALID_JSON: () => 'This is not valid JSON. Use Download in n8n to get a clean workflow file.',
  NOT_A_WORKFLOW: () => 'This JSON has no n8n workflow nodes array. Credentials and settings exports will not scan.',
  INTERNAL: () => 'The local scanner worker failed. Retry creates a fresh worker; nothing was sent anywhere.',
  TIMEOUT: () => `This scan exceeded the ${(DEFAULT_SCANNER_LIMITS.workerDeadlineMs / 1000)}-second local time budget and was stopped. Retry starts a fresh worker.`,
  V2_TOO_COMPLEX: () => 'This workflow exceeds a local scanner complexity limit. Simplify it or split it into smaller workflows and try again.',
  V2_FAILURE: () => 'The local scanner could not complete this scan. Check the workflow JSON and try again.',
};
const RETRYABLE_ERROR_CODES: ReadonlySet<ScannerErrorCode> = new Set(['INTERNAL', 'TIMEOUT']);

export function ScannerClient({ now = Date.now }: { now?: () => number } = {}) {
  const [isScanning, setIsScanning] = useState(false);
  // Non-null exactly while a run is in flight; `startedAt` is the elapsed timer's origin.
  const [progress, setProgress] = useState<{ phase: string; pct: number; startedAt: number } | null>(null);
  const [result, setResult] = useState<ScanWorkflowResult | null>(null);
  const [prerequisites, setPrerequisites] = useState<ReportPrerequisitesModel | null>(null);
  const [scanError, setScanError] = useState<{ code: ScannerErrorCode; message: string } | null>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestGeneration = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<ScanRequest | null>(null);
  const focusEditorAfterCancel = useRef(false);

  useEffect(() => () => {
    requestGeneration.current += 1;
    controllerRef.current?.abort();
  }, []);

  // The cancel button unmounts with the progress surface, so without this a
  // keyboard user is dropped onto <body>. Hand focus to the editor: after a
  // cancel, editing (or re-submitting) is the next legitimate action.
  useEffect(() => {
    if (!focusEditorAfterCancel.current || isScanning) return;
    focusEditorAfterCancel.current = false;
    document.getElementById('workflow-json')?.focus(); // editor textarea (scanner-input.tsx:145)
  });

  async function startScan(request: ScanRequest) {
    const requestId = ++requestGeneration.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    lastRequestRef.current = request;
    setScanError(null);
    setResult(null);
    setPrerequisites(null);
    setIsScanning(true);
    setProgress({ phase: 'parse', pct: 10, startedAt: now() });

    try {
      const res = await runScanV2({
        ...request,
        signal: controller.signal,
        onProgress: (phase, pct) => {
          if (requestGeneration.current !== requestId) return;
          // Immutable update: the run's origin must survive every progress message.
          setProgress((current) => (current ? { ...current, phase, pct } : current));
        },
      });
      if (requestGeneration.current !== requestId) return;
      controllerRef.current = null;
      setIsScanning(false);
      setProgress(null);
      if (res === 'cancelled') return;
      setResult(res);
      setPrerequisites(createPrerequisiteSidecar(request.json, requestId, res));
    } catch (error: unknown) {
      if (requestGeneration.current !== requestId) return;
      controllerRef.current = null;
      setIsScanning(false);
      setProgress(null);
      setPrerequisites(null);
      const code: ScannerErrorCode = error instanceof ScanError ? error.code : 'INTERNAL';
      const details = error instanceof ScanError ? error.details : undefined;
      setScanError({ code, message: ERROR_MESSAGES[code](details) });
    }
  }

  function cancelCurrentScan() {
    requestGeneration.current += 1;
    // The abort listener inside the adapter terminates the Worker instance rather
    // than hiding it (scanner-v2-adapter.ts:170-175 → cancelActive:98 → terminateActive:92),
    // and drops the terminated instance so the next run builds a fresh one.
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsScanning(false);
    setProgress(null);
    setResult(null);
    setPrerequisites(null);
    focusEditorAfterCancel.current = true;
  }

  function retryLastScan() {
    const request = lastRequestRef.current;
    if (request) void startScan(request);
  }

  const canRetry = scanError !== null && RETRYABLE_ERROR_CODES.has(scanError.code);
  const phaseMessage = progress ? PHASE_LABELS[progress.phase] ?? PENDING_PHASE_LABEL : '';

  return (
    <div className="flex flex-col gap-6">
      {/* Always mounted and outside the busy subtree below: a region that appears
          already filled is not a change AT can announce, and `aria-busy` lets AT
          defer updates inside its subtree. Its text changes only on a phase
          change — never on a tick, never with the percentage. */}
      <p role="status" aria-live="polite" aria-atomic="true" aria-label="Scan status" className="sr-only">
        {isScanning ? phaseMessage : ''}
      </p>
      <ScannerInput isScanning={isScanning} hasResult={result !== null} onScan={startScan} onDraftChange={() => setPrerequisites(null)} />

      {isScanning && progress
        ? <ScanProgress label={phaseMessage} pct={progress.pct} startedAt={progress.startedAt} now={now} onCancel={cancelCurrentScan} />
        : null}

      {scanError ? <div className="rounded-panel border border-sev-critical bg-raised p-4 text-sev-critical" role="alert">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-mono text-xs font-bold">{scanError.code}</p>
            <p className="mt-1 text-sm text-ink">{scanError.message}</p>
            {canRetry && <button type="button" onClick={retryLastScan}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-control border border-sev-critical bg-panel px-3 font-mono text-xs font-semibold text-ink transition-all hover:bg-accent-dim active:translate-y-px">
              <RotateCcw className="h-4 w-4" aria-hidden="true" /><span>Retry scan</span>
            </button>}
          </div>
        </div>
      </div> : null}

      {result ? <ReportResult scan={result} prerequisites={prerequisites ?? undefined} outcomeHeadingRef={outcomeHeadingRef} onRetry={retryLastScan} /> : null}
    </div>
  );
}
