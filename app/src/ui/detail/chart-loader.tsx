'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { loadPreviewById, type PreviewResult } from '../../catalogue/preview-client';
import { loadChart } from '../../catalogue/shard-client';
import { StaticWorkflowPreview } from './static-preview';
import { safeHttpUrl } from '../../seo/hostile-text';
import { CHART_MESSAGES, CHART_RETRYABLE, PREVIEW_MESSAGES, PREVIEW_RETRYABLE, type ChartDisplayResult } from './chart-loader-copy';

type ChartLoaderProps = {
  entry: Entry;
  /** Supplied by a statically rendered page; omitted on the client-only view. */
  preview?: SvgPreviewArtifact | null;
  /** Client-only view opts into fetching the preview artifact after entry load. */
  loadPreview?: boolean;
  /** Test seam for the finite timeout; production defaults to 15 seconds. */
  interactiveTimeoutMs?: number;
  /** Test seam for the local dynamic chunk; production uses the real module. */
  loadCanvasModule?: () => Promise<{ WorkflowChartComponent: WorkflowChartComponentType }>;
};
type WorkflowChartComponentType = (typeof import('../workflow-chart'))['WorkflowChartComponent'];
const INTERACTIVE_TIMEOUT_MS = 15_000;
const loadWorkflowChart = () => import('../workflow-chart');

const PREVIEW_REGION = 'min-h-48';
const PANEL = `flex ${PREVIEW_REGION} flex-col items-center justify-center gap-3 rounded-panel border border-hairline bg-panel px-6 py-8 text-center font-mono text-xs text-ink-muted`;
function ActionButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 rounded-control border border-hairline px-4 text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised"
    >
      {children}
    </button>
  );
}

function SourceLink({ entry }: { entry: Entry }) {
  const href = safeHttpUrl(entry.source.permalink, '');
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-text underline underline-offset-2 hover:text-ink">
      Open the workflow at its source
    </a>
  );
}

/**
 * A preview is the default detail surface. The heavy interactive module and
 * chart shard are both deferred until the reader explicitly asks for them.
 * Every transport outcome settles into a finite state, including cancellation.
 */
export function ChartLoader({ entry, preview, loadPreview = false, interactiveTimeoutMs = INTERACTIVE_TIMEOUT_MS, loadCanvasModule = loadWorkflowChart }: ChartLoaderProps) {
  const [previewState, setPreviewState] = useState<PreviewResult | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [interactiveState, setInteractiveState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [chartResult, setChartResult] = useState<ChartDisplayResult | null>(null);
  const [Canvas, setCanvas] = useState<WorkflowChartComponentType | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);
  const requestGenerationRef = useRef(0);

  const invalidateInteractive = useCallback(() => {
    requestGenerationRef.current += 1;
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const cancelInteractive = useCallback(() => {
    invalidateInteractive();
    setInteractiveState('idle');
    setChartResult(null);
    setCanvas(null);
  }, [invalidateInteractive]);

  useEffect(() => {
    if (!loadPreview || preview !== undefined) return;
    const controller = new AbortController();
    let active = true;
    void loadPreviewById(entry.id, controller.signal)
      .then((result) => { if (active) setPreviewState(result); })
      .catch(() => { if (active) setPreviewState({ ok: false, reason: 'network' }); });
    return () => { active = false; controller.abort(); };
  }, [entry.id, loadPreview, preview, previewAttempt]);

  const displayedIdentityRef = useRef({ id: entry.id, shard: entry.chartRef?.shard, offset: entry.chartRef?.offset, length: entry.chartRef?.length });
  useEffect(() => {
    const next = { id: entry.id, shard: entry.chartRef?.shard, offset: entry.chartRef?.offset, length: entry.chartRef?.length };
    const previous = displayedIdentityRef.current;
    displayedIdentityRef.current = next;
    if (previous.id !== next.id || previous.shard !== next.shard || previous.offset !== next.offset || previous.length !== next.length) cancelInteractive();
  }, [cancelInteractive, entry.id, entry.chartRef?.shard, entry.chartRef?.offset, entry.chartRef?.length]);
  useEffect(() => () => invalidateInteractive(), [invalidateInteractive]);

  const retryPreview = useCallback(() => {
    setPreviewState(null);
    setPreviewAttempt((value) => value + 1);
  }, []);

  const exploreInteractive = useCallback(async () => {
    if (!entry.chartRef || interactiveState === 'loading') return;
    const controller = new AbortController();
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    controllerRef.current = controller;
    let timedOut = false;
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('interactive chart timeout'));
      }, interactiveTimeoutMs);
      timeoutRef.current = timeoutId;
    });
    setInteractiveState('loading');
    setChartResult(null);
    try {
      const workflowChartModule = await Promise.race([loadCanvasModule(), timeout]);
      if (controller.signal.aborted || requestGenerationRef.current !== requestGeneration) return;
      const result = await Promise.race([loadChart(entry.chartRef, controller.signal), timeout]);
      if (controller.signal.aborted || requestGenerationRef.current !== requestGeneration) return;
      if (!result.ok) {
        setChartResult(result);
        setInteractiveState(result.reason === 'aborted' ? 'idle' : 'error');
        return;
      }
      setChartResult(result);
      setCanvas(() => workflowChartModule.WorkflowChartComponent);
      setInteractiveState('ready');
    } catch {
      if (timedOut && requestGenerationRef.current === requestGeneration) {
        setChartResult({ ok: false, reason: 'timeout' });
        setInteractiveState('error');
      } else if (!controller.signal.aborted && requestGenerationRef.current === requestGeneration) {
        setChartResult({ ok: false, reason: 'network' });
        setInteractiveState('error');
      }
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (timeoutRef.current === timeoutId) timeoutRef.current = undefined;
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [entry.chartRef, interactiveState, interactiveTimeoutMs, loadCanvasModule]);

  const previewArtifact = preview ?? (previewState?.ok ? previewState.preview : null);
  const previewFailure = preview === undefined && previewState && !previewState.ok ? previewState.reason : null;
  const currentChart = chartResult?.ok ? chartResult.chart : null;

  if (interactiveState === 'ready' && Canvas && currentChart) {
    return (
      <div data-interactive-canvas className="space-y-3">
        <div className="flex justify-end"><ActionButton onClick={cancelInteractive}>Back to static preview</ActionButton></div>
        <Canvas chart={currentChart} entryTitle={entry.title} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div data-testid="chart-preview-region" className={PREVIEW_REGION}>
        {previewArtifact ? <StaticWorkflowPreview preview={previewArtifact} /> : loadPreview && !previewFailure ? (
          <div role="status" aria-busy="true" className={`${PANEL} animate-pulse`}>Loading static workflow preview</div>
        ) : (
          <div role="status" className={PANEL}>
            <p className="text-ink">{previewFailure ? PREVIEW_MESSAGES[previewFailure] : 'Static preview unavailable for this release.'}</p>
            {previewFailure && PREVIEW_RETRYABLE.has(previewFailure) && <ActionButton onClick={retryPreview}>Try preview again</ActionButton>}
          </div>
        )}
      </div>
      {entry.chartRef ? (
        <div className="flex flex-wrap items-center gap-3">
          {interactiveState === 'loading' ? (
            <div role="status" aria-busy="true" className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
              <span>Loading interactive canvas</span>
              <ActionButton onClick={cancelInteractive}>Cancel</ActionButton>
            </div>
          ) : interactiveState === 'error' && chartResult && !chartResult.ok ? (
            <div role="status" className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
              <span>{CHART_MESSAGES[chartResult.reason]}</span>
              {chartResult.reason !== 'timeout' && chartResult.release ? (
                <span className="font-mono text-2xs text-ink-faint">
                  Release {chartResult.release.generatedAt} · shard {chartResult.release.shardSha256.slice(0, 12)}
                </span>
              ) : null}
              {CHART_RETRYABLE.has(chartResult.reason) && <ActionButton onClick={() => void exploreInteractive()}>Try again</ActionButton>}
            </div>
          ) : (
            <ActionButton onClick={() => void exploreInteractive()}>Explore interactive canvas</ActionButton>
          )}
        </div>
      ) : (
        <p role="status" className="text-xs text-ink-muted">{CHART_MESSAGES['no-chart']}</p>
      )}
      <SourceLink entry={entry} />
    </div>
  );
}
