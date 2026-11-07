'use client';

import React from 'react';

type ChartDefsProps = {
  /** Current canvas zoom, so arrowheads can hold their on-screen size. */
  scale?: number;
};

/** Arrowhead edge length in CSS pixels, held constant across the zoom range. */
const ARROW_PX = 9;

/**
 * `markerUnits="userSpaceOnUse"` on its own would make this *worse*. The default
 * is `strokeWidth`, which sized the marker at 6 x 1.75 = 10.5 user units;
 * switching to user space without compensating drops it to 6, and both still
 * shrink with the canvas transform. At the corpus median scale of 0.335 that is
 * a 3.5px arrowhead, and at the 0.18 floor it is 1.9px — which is why edges
 * looked like they had no direction (audit 2026-08-25, CV-2b).
 *
 * Dividing by the scale holds the rendered size at `ARROW_PX`. `refX`/`refY`
 * stay in the marker's own `viewBox` coordinates, so the tip keeps meeting the
 * line end whatever `markerWidth` becomes.
 */
export function ChartDefs({ scale = 1 }: ChartDefsProps) {
  const markerSize = ARROW_PX / Math.max(scale, 0.05);

  return (
    <defs>
      {/* Background Dot Grid Pattern */}
      <pattern id="wf-grid-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" fill="var(--color-ink-muted)" fillOpacity="0.12" />
      </pattern>

      {/* Directional Arrowheads */}
      <marker
        id="wf-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerUnits="userSpaceOnUse"
        markerWidth={markerSize}
        markerHeight={markerSize}
        orient="auto-start-reverse"
      >
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--color-structure)" fillOpacity="0.75" />
      </marker>

      <marker
        id="wf-arrow-active"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerUnits="userSpaceOnUse"
        markerWidth={markerSize}
        markerHeight={markerSize}
        orient="auto-start-reverse"
      >
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--color-accent)" />
      </marker>

      {/* Node Glow Filters */}
      <filter id="wf-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
    </defs>
  );
}
