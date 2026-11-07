'use client';

import React, { useMemo, useState } from 'react';
import type { LayoutEdge, LayoutNode } from '@hub/contracts';

type ChartNodeListProps = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  selectedNodeId?: string;
  onActivate: (node: LayoutNode) => void;
};

const buttonClass = 'min-h-11 w-full rounded-control border border-transparent px-2 text-left text-ink transition-colors hover:border-hairline hover:bg-raised active:bg-accent-dim active:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border';
const selectedClass = 'border-accent-border bg-accent-dim text-accent-text';
const NODE_WINDOW = 40;

export function ChartNodeList({ nodes, edges, selectedNodeId, onActivate }: ChartNodeListProps) {
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const edgeLabel = `${edges.length} ${edges.length === 1 ? 'connection' : 'connections'}`;
  const [visibleCount, setVisibleCount] = useState(NODE_WINDOW);
  const windowNodes = nodes.slice(0, visibleCount);
  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : undefined;
  const visibleNodes = selectedNode && !windowNodes.some((node) => node.id === selectedNode.id)
    ? [...windowNodes, selectedNode]
    : windowNodes;
  const remainingCount = Math.max(0, nodes.length - visibleCount);

  return (
    <details data-canvas-control className="min-w-0 max-w-full border-t border-hairline px-2 text-xs font-mono text-ink-muted">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-control px-2 transition-colors hover:bg-raised hover:text-accent-text active:bg-accent-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
        View workflow node list ({nodes.length} nodes, {edgeLabel})
      </summary>
      <ul className="max-h-48 space-y-1 overflow-y-auto border-l border-hairline pb-2 pl-2">
        {visibleNodes.map((node) => {
          const outgoing = edges
            .filter((edge) => edge.from === node.id)
            .map((edge) => nodeNames.get(edge.to))
            .filter((name): name is string => Boolean(name));
          const isSelected = selectedNodeId === node.id;
          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onActivate(node)}
                aria-label={`Focus ${node.name} node`}
                aria-pressed={isSelected}
                className={`${buttonClass} ${isSelected ? selectedClass : ''}`}
              >
                <span className="font-medium">{node.name}</span>{' '}
                <span className="text-ink-faint">({node.type})</span>
                {outgoing.length > 0 && (
                  <span className="text-ink-muted"> → connects to: {outgoing.join(', ')}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {remainingCount > 0 && (
        <div className="space-y-1 py-2 pl-2">
          <p role="status" className="text-2xs text-ink-faint">
            {remainingCount} additional {remainingCount === 1 ? 'node is' : 'nodes are'} available.
          </p>
          <button
            type="button"
            data-canvas-control
            onClick={() => setVisibleCount((count) => Math.min(nodes.length, count + NODE_WINDOW))}
            className={buttonClass}
            aria-label={`Show ${Math.min(NODE_WINDOW, remainingCount)} more nodes`}
          >
            Show {Math.min(NODE_WINDOW, remainingCount)} more nodes
          </button>
        </div>
      )}
    </details>
  );
}
