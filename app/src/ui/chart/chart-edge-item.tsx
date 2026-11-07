'use client';

import React from 'react';
import type { LayoutEdge } from '@hub/contracts';

type ChartEdgeItemProps = {
  edge: LayoutEdge;
  isHighlighted: boolean;
  isDimmed: boolean;
};

export function ChartEdgeItem({ edge, isHighlighted, isDimmed }: ChartEdgeItemProps) {
  const strokeColor = isHighlighted ? 'var(--color-accent)' : 'var(--color-structure)';
  const strokeWidth = isHighlighted ? 2.5 : 1.75;
  const strokeOpacity = isDimmed ? 0.2 : isHighlighted ? 0.95 : 0.55;
  const markerEnd = isHighlighted ? 'url(#wf-arrow-active)' : 'url(#wf-arrow)';

  return (
    <g className="transition-opacity duration-150">
      {/* Background shadow curve for clarity */}
      <path
        d={edge.pathD}
        fill="none"
        stroke="var(--color-page)"
        strokeWidth={strokeWidth + 2}
        strokeOpacity={0.8}
        vectorEffect="non-scaling-stroke"
      />
      {/*
        Active line path. `non-scaling-stroke` keeps the width in device pixels
        rather than user units: the canvas transform sits at 0.335 on a median
        corpus chart, which rendered a 1.75 stroke at 0.59 CSS pixels — thinner
        than a browser paints as a solid line, so edges looked absent on graphs
        whose data was perfectly sound (audit 2026-08-25, CV-2b).
      */}
      <path
        d={edge.pathD}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeOpacity={strokeOpacity}
        markerEnd={markerEnd}
        vectorEffect="non-scaling-stroke"
      />
      {/* Animated subtle particle on highlighted edges */}
      {isHighlighted && (
        <circle r="3" fill="var(--color-accent)">
          <animateMotion path={edge.pathD} dur="2s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}
