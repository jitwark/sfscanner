'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { SvgPreviewArtifact } from '@hub/contracts';
import { generateNodeFlowchartSvg } from './node-flowchart-fallback';
import { CanvasViewport } from './canvas-viewport';

type CompactVectorDiagramProps = {
  preview?: SvgPreviewArtifact | null;
  title?: string;
  showNodeList?: boolean;
  /**
   * `Expand diagram` opens a dialog whose open/closed and zoom state live in
   * React. A tier that renders once and never hydrates cannot honour the click,
   * so it turns the control off rather than shipping a dead button.
   */
  expandable?: boolean;
};

const SVG_ROOT = /^<svg\b[^>]*>/i;

function makeSvgDecorative(svg: string): string {
  const root = svg.match(SVG_ROOT)?.[0];
  if (!root) return svg;
  const attributes = root
    .replace(/\saria-hidden\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
    .replace(/\sfocusable\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
    .replace(/\stabindex\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  return `${attributes.slice(0, -1)} aria-hidden="true" focusable="false">${svg.slice(root.length)}`;
}

export function CompactVectorDiagram({ preview, title, showNodeList = true, expandable = true }: CompactVectorDiagramProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closingForCleanup = useRef(false);
  const titleId = useId();

  // Focus handoff is explicit. The native element owns containment (top layer),
  // and `showModal()` does not focus the control we want, so we do.
  function restoreFocus() {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }

  function closeModal() {
    dialogRef.current?.close();
    // Synchronous: the native `close` event is queued and React may unmount the
    // dialog first, which is exactly how the opener lost focus in the old modal.
    restoreFocus();
    setModalOpen(false);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modalOpen && !dialog.open) {
      closingForCleanup.current = false;
      openerRef.current = dialog.parentElement?.querySelector<HTMLElement>('[aria-label="Expand diagram"]')
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      dialog.showModal();
      closeButtonRef.current?.focus();
    }
    return () => {
      if (dialog.open) {
        closingForCleanup.current = true;
        dialog.close();
        restoreFocus();
      }
    };
  }, [modalOpen]);

  if (!preview) {
    return (
      <div className="flex h-36 items-center justify-center rounded-md border border-hairline bg-raised/40 p-4 text-center font-mono text-xs text-ink-muted">
        Static vector preview not available for this release.
      </div>
    );
  }

  const isChartOnly = preview.tier === 'C' || !preview.svg.includes('<path') || preview.svg.includes('tier C');
  const renderedSvg = isChartOnly ? generateNodeFlowchartSvg(preview.nodeList) : preview.svg;

  const diagramLabel = preview.tier === 'invalid'
    ? `Workflow diagram unavailable, tier ${preview.tier}, ${preview.nodeList.length} nodes`
    : `Workflow vector diagram, tier ${preview.tier}, ${preview.nodeList.length} nodes`;

  function handleDownloadSvg() {
    if (!renderedSvg) return;
    const blob = new Blob([renderedSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(title || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-diagram.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div data-compact-vector-diagram className="space-y-2.5">
      <CanvasViewport
        svg={makeSvgDecorative(renderedSvg)}
        label={diagramLabel}
        heightClass="h-[220px] sm:h-[260px]"
        onDownloadSvg={handleDownloadSvg}
        onPopout={expandable ? () => setModalOpen(true) : undefined}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-ink-muted">
        <div className="flex items-center gap-3">
          <span className="rounded border border-hairline bg-raised px-1.5 py-0.5 text-2xs uppercase">Tier {preview.tier}</span>
          <span>{preview.nodeList.length} nodes</span>
          {preview.unresolvedEdgeCount > 0 && (
            <span className="text-sev-medium">{preview.unresolvedEdgeCount} unlinked</span>
          )}
        </div>
        <span className="text-2xs text-ink-faint">Drag to pan · Ctrl/⌘ + scroll or toolbar to zoom</span>
      </div>

      {showNodeList && (
        <details className="group/nodes rounded-md border border-hairline bg-raised/60 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-xs text-ink hover:text-accent-text">
            <span>Inspect workflow nodes ({preview.nodeList.length})</span>
            <span className="text-ink-faint transition-transform group-open/nodes:rotate-180" aria-hidden="true">▾</span>
          </summary>
          <pre aria-label="Workflow node list" className="mt-2.5 max-h-48 overflow-auto break-words font-mono text-xs leading-5 text-ink-muted">
            {preview.nodeList.map((node) => `${node.name || 'Unnamed node'} — ${node.type}`).join('\n')}
          </pre>
        </details>
      )}

      {modalOpen && (
        <dialog
          ref={dialogRef}
          aria-modal="true"
          aria-labelledby={titleId}
          onCancel={(event) => { event.preventDefault(); closeModal(); }}
          onClose={() => {
            if (closingForCleanup.current) { closingForCleanup.current = false; return; }
            setModalOpen(false);
            restoreFocus();
          }}
          onClick={(event) => {
            // The `<dialog>` box also owns its own padding and scrollbar, so
            // "target === currentTarget" dismissed the panel from clicks well
            // inside its visible edge. Only the surface outside the dialog's
            // rectangle is the backdrop. The identity check stays first so a
            // child (including a keyboard-activated button reporting 0,0) can
            // never be mistaken for one.
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const outside = event.clientX < rect.left || event.clientX > rect.right
              || event.clientY < rect.top || event.clientY > rect.bottom;
            if (outside) closeModal();
          }}
          className="m-auto max-h-[95vh] w-[min(72rem,calc(100vw-2rem))] overflow-y-auto rounded-panel border border-hairline bg-panel p-4 text-ink shadow-2xl backdrop:bg-page/80 backdrop:backdrop-blur-sm sm:p-6"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
            <h3 id={titleId} className="font-display text-lg font-semibold">
              {title || 'Workflow diagram'}{' '}
              <span className="font-mono text-xs font-normal text-ink-muted">(Tier {preview.tier})</span>
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleDownloadSvg}
                className="min-h-11 rounded-md border border-hairline bg-raised px-3 font-mono text-xs text-ink"
              >
                Download SVG
              </button>
              <button
                ref={closeButtonRef}
                data-dialog-close
                type="button"
                onClick={closeModal}
                className="min-h-11 rounded-md border border-hairline px-3 font-mono text-xs text-ink-muted"
              >
                ✕ Close
              </button>
            </div>
          </div>

          <CanvasViewport
            svg={makeSvgDecorative(renderedSvg)}
            label={diagramLabel}
            heightClass="h-[60vh] sm:h-[70vh]"
            isModal
            onDownloadSvg={handleDownloadSvg}
          />
        </dialog>
      )}
    </div>
  );
}
