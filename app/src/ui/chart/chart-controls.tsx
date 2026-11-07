'use client';

import React, { type Ref } from 'react';

type ChartControlsProps = {
  scale: number;
  nodeCount: number;
  edgeCount: number;
  hasTrigger: boolean;
  isFullscreen: boolean;
  showAnnotations: boolean;
  fullscreenButtonRef?: Ref<HTMLButtonElement>;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onFocusTrigger: () => void;
  onReset: () => void;
  onToggleAnnotations: () => void;
  onToggleFullscreen: () => void;
};

const buttonClass = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-hairline bg-raised px-3 text-xs font-mono text-ink-muted transition-colors hover:border-hairline-strong hover:text-accent-text active:bg-accent-dim active:text-accent-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border';
const selectedClass = 'border-accent-border bg-accent-dim text-accent-text';
const iconClass = 'h-4 w-4';

export function ChartControls(props: ChartControlsProps) {
  const {
    scale,
    nodeCount,
    edgeCount,
    hasTrigger,
    isFullscreen,
    showAnnotations,
    fullscreenButtonRef,
    onZoomIn,
    onZoomOut,
    onFit,
    onFocusTrigger,
    onReset,
    onToggleAnnotations,
    onToggleFullscreen,
  } = props;

  return (
    <div
      data-canvas-control
      role="toolbar"
      aria-label="Workflow diagram controls"
      className="flex w-full flex-wrap items-center gap-2 border-b border-hairline bg-panel p-2"
    >
      <span className="mr-auto px-2 text-2xs font-mono text-ink-muted">
        {nodeCount} nodes · {edgeCount} {edgeCount === 1 ? 'connection' : 'connections'} · {Math.round(scale * 100)}%
      </span>
      <button type="button" onClick={onZoomOut} title="Zoom out" aria-label="Zoom out" className={buttonClass}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass} aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button type="button" onClick={onZoomIn} title="Zoom in" aria-label="Zoom in" className={buttonClass}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass} aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button type="button" onClick={onFit} aria-label="Fit workflow to view" className={buttonClass}>Fit</button>
      <button type="button" onClick={onFocusTrigger} disabled={!hasTrigger} aria-label="Focus trigger node" className={buttonClass}>Trigger</button>
      <button type="button" onClick={onToggleAnnotations} aria-label={showAnnotations ? 'Hide annotation nodes' : 'Show annotation nodes'} aria-pressed={showAnnotations} className={`${buttonClass} ${showAnnotations ? selectedClass : ''}`}>
        Notes {showAnnotations ? 'on' : 'off'}
      </button>
      <button type="button" onClick={onReset} title="Reset workflow view to fit" aria-label="Reset workflow view to fit" className={buttonClass}>Reset</button>
      <button
        ref={fullscreenButtonRef}
        type="button"
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen view'}
        aria-pressed={isFullscreen}
        className={`${buttonClass} ${isFullscreen ? selectedClass : ''}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass} aria-hidden="true">
          {isFullscreen ? (
            <>
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </>
          ) : (
            <>
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
