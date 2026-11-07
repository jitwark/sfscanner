'use client';

import React, { useState } from 'react';
import type { GraphLayout, LayoutNode } from '@hub/contracts';
import { NodeIcon } from './chart-icons';

const NEIGHBOR_WINDOW = 12;

function NeighborList({ nodes, direction, onSelectNode }: {
  nodes: LayoutNode[];
  direction: 'in' | 'out';
  onSelectNode: (node: LayoutNode) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(NEIGHBOR_WINDOW);
  const visibleNodes = nodes.slice(0, visibleCount);
  const remainingCount = Math.max(0, nodes.length - visibleCount);
  const label = direction === 'in' ? 'input' : 'output';
  return (
    <div>
      <span className="text-2xs text-ink-faint">{direction === 'in' ? 'Inputs' : 'Outputs'} ({nodes.length}):</span>
      <div className="mt-1 flex flex-wrap gap-1">
        {visibleNodes.map((neighbor) => (
          <button
            key={neighbor.id}
            type="button"
            onClick={() => onSelectNode(neighbor)}
            className="inline-flex min-h-11 max-w-full items-center gap-1 truncate rounded-control border border-hairline bg-raised px-3 text-2xs text-ink-muted transition-colors hover:bg-accent/20 hover:text-accent-text active:bg-accent-dim active:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
          >
            {direction === 'in' && <span>←</span>}
            <span className="truncate">{neighbor.name}</span>
            {direction === 'out' && <span>→</span>}
          </button>
        ))}
      </div>
      {remainingCount > 0 && (
        <div className="mt-1 space-y-1">
          <p role="status" className="text-2xs text-ink-faint">{remainingCount} additional {label} {remainingCount === 1 ? 'node is' : 'nodes are'} available.</p>
          <button
            type="button"
            data-canvas-control
            onClick={() => setVisibleCount((count) => Math.min(nodes.length, count + NEIGHBOR_WINDOW))}
            className="min-h-11 rounded-control px-2 text-left text-2xs text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
            aria-label={`Show ${Math.min(NEIGHBOR_WINDOW, remainingCount)} more ${label} nodes`}
          >
            Show {Math.min(NEIGHBOR_WINDOW, remainingCount)} more
          </button>
        </div>
      )}
    </div>
  );
}

type ChartInspectorProps = {
  node: LayoutNode | null;
  layout: GraphLayout;
  onSelectNode: (node: LayoutNode) => void;
  onClose: () => void;
};

export function ChartInspector({ node, layout, onSelectNode, onClose }: ChartInspectorProps) {
  if (!node) return null;

  const incomingEdges = layout.edges.filter((e) => e.to === node.id);
  const outgoingEdges = layout.edges.filter((e) => e.from === node.id);

  const incomingNodes = incomingEdges
    .map((e) => layout.nodes.find((n) => n.id === e.from))
    .filter((n): n is LayoutNode => Boolean(n));

  const outgoingNodes = outgoingEdges
    .map((e) => layout.nodes.find((n) => n.id === e.to))
    .filter((n): n is LayoutNode => Boolean(n));

  return (
    <aside
      data-canvas-control
      aria-label="Node Inspector"
      className="absolute bottom-3 left-3 z-20 max-h-[calc(100%-1.5rem)] w-[calc(100%-24px)] max-w-sm overflow-y-auto rounded-panel border border-hairline bg-panel/95 p-4 text-xs font-mono shadow-2xl backdrop-blur-md sm:w-80"
    >
      <div className="flex items-start justify-between gap-2 border-b border-hairline pb-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-raised text-accent-text">
            <NodeIcon category={node.category} type={node.type} className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-semibold text-ink text-sm truncate font-sans">{node.name}</h4>
            <span className="text-2xs text-ink-faint uppercase tracking-wider">{node.category}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-raised hover:text-ink active:bg-accent-dim active:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="space-y-2.5">
        <div>
          <span className="text-2xs text-ink-faint">Node Type:</span>
          <p className="text-ink-muted text-2xs truncate select-all">{node.type}</p>
        </div>

        {incomingNodes.length > 0 && <NeighborList nodes={incomingNodes} direction="in" onSelectNode={onSelectNode} />}
        {outgoingNodes.length > 0 && <NeighborList nodes={outgoingNodes} direction="out" onSelectNode={onSelectNode} />}
      </div>
    </aside>
  );
}
