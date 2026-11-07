'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';

type CanvasViewportProps = {
  svg: string;
  label: string;
  heightClass?: string;
  isModal?: boolean;
  onDownloadSvg?: () => void;
  onPopout?: () => void;
};

export function CanvasViewport({
  svg,
  label,
  heightClass = 'h-[220px] sm:h-[260px]',
  isModal = false,
  onDownloadSvg,
  onPopout,
}: CanvasViewportProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  // React registers its root `wheel` listener as passive, so `preventDefault()`
  // inside a synthetic handler is discarded: the canvas zoomed while the page or
  // dialog scrolled (and macOS zoomed the browser). Bind the same element
  // natively instead, and only cancel the events this component actually handles.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey && !isModal) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.15 : -0.15;
      setZoom((z) => Math.min(2.5, Math.max(0.5, Number((z + delta).toFixed(2)))));
    }
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [isModal]);

  function handleZoomIn() {
    setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))));
  }

  function handleZoomOut() {
    setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
  }

  function handleReset() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || e.button !== 0 || dragPointerIdRef.current !== null) return;
    dragPointerIdRef.current = e.pointerId;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  }

  function handlePointerEnd(e: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    dragPointerIdRef.current = null;
    setIsDragging(false);
  }

  const zoomPercent = Math.round(zoom * 100);
  const cursorClass = isDragging ? 'cursor-grabbing' : zoom > 1 || isModal ? 'cursor-grab' : 'cursor-default';

  return (
    <div
      ref={viewportRef}
      data-canvas-viewport
      className="relative overflow-hidden rounded-md border border-hairline bg-page/80 select-none"
      style={{
        backgroundImage: 'radial-gradient(var(--theme-hairline) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
      }}
    >
      {/* Canvas Controls Toolbar */}
      <div className="absolute right-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-1 rounded-md border border-hairline/90 bg-panel/95 px-2 py-1 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={handleZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          className="flex min-h-11 min-w-11 items-center justify-center rounded font-mono text-xs text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          -
        </button>
        <button
          type="button"
          onClick={handleReset}
          title="Reset zoom to 100%"
          aria-label="Reset zoom to 100%"
          className="flex min-h-11 min-w-11 items-center justify-center px-1 font-mono text-2xs font-semibold text-ink-muted transition-colors hover:text-ink"
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          onClick={handleZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
          disabled={zoom >= 2.5}
          className="flex min-h-11 min-w-11 items-center justify-center rounded font-mono text-xs text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          +
        </button>

        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
          <button
            type="button"
            onClick={handleReset}
            title="Fit to canvas"
            aria-label="Fit to canvas"
            className="rounded bg-raised min-h-11 min-w-11 px-2 font-mono text-2xs text-ink hover:text-accent-text"
          >
            Fit
          </button>
        )}

        {onDownloadSvg && (
          <>
            <span className="text-hairline" aria-hidden="true">|</span>
            <button
              type="button"
              onClick={onDownloadSvg}
              title="Download vector SVG"
              aria-label="Download vector SVG"
              className="min-h-11 min-w-11 px-1 font-mono text-2xs text-ink-muted transition-colors hover:text-ink"
            >
              ⤓ SVG
            </button>
          </>
        )}

        {onPopout && !isModal && (
          <>
            <span className="text-hairline" aria-hidden="true">|</span>
            <button
              type="button"
              onClick={onPopout}
              title="Expand diagram"
              aria-label="Expand diagram"
              className="min-h-11 min-w-11 px-1 font-mono text-2xs text-ink-muted transition-colors hover:text-ink"
            >
              ⤢ Popout
            </button>
          </>
        )}
      </div>

      {/* SVG Canvas Stage */}
      <div
        role="img"
        aria-label={label}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        className={`flex w-full items-center justify-center p-3 ${heightClass} ${cursorClass}`}
        style={{ touchAction: 'none' }}
      >
        <div
          data-viewport-target="true"
          className="flex h-full w-full items-center justify-center transition-transform [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:w-full [&>svg]:max-w-full [&_text]:fill-[var(--theme-ink)] [&_path]:stroke-[var(--theme-hairline-strong)]"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 120ms ease-out',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
