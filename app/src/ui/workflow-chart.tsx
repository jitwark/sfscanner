'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { computeGraphLayout, type LayoutNode, type WorkflowChart } from '@hub/contracts';
import { isFunctionalNode } from '@hub/contracts/functional-nodes';
import { ChartControls } from './chart/chart-controls';
import { ChartDefs } from './chart/chart-defs';
import { ChartEdgeItem } from './chart/chart-edge-item';
import { ChartInspector } from './chart/chart-inspector';
import { ChartNodeItem } from './chart/chart-node-item';
import { ChartNodeList } from './chart/chart-node-list';
import { useWorkflowCanvas } from './chart/use-workflow-canvas';

type WorkflowChartProps = { chart: WorkflowChart; entryTitle?: string };

export function WorkflowChartComponent({ chart, entryTitle }: WorkflowChartProps) {
  const [selectedNode, setSelectedNode] = useState<LayoutNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<LayoutNode | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const fullscreenRef = useRef<HTMLElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenOpenerRef = useRef<HTMLElement | null>(null);
  const visibleChart = useMemo(() => {
    if (showAnnotations) return chart;
    const nodes = chart.nodes.filter((node) => node.isAnnotation !== true && isFunctionalNode(node.type));
    const nodeReferences = new Set(nodes.flatMap((node) => [node.id, node.name]));
    return { ...chart, nodes, edges: chart.edges.filter((edge) => nodeReferences.has(edge.from) && nodeReferences.has(edge.to)) };
  }, [chart, showAnnotations]);
  const layout = useMemo(() => computeGraphLayout(visibleChart), [visibleChart]);
  // Where the reader should be looking when a graph is too wide to fit legibly:
  // the trigger, falling back to the leftmost node so a left-to-right flow still
  // opens at its beginning.
  const anchorNode = useMemo(() => {
    const trigger = layout.nodes.find((node) => node.category === 'trigger');
    return trigger ?? [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y)[0];
  }, [layout]);
  const {
    containerRef,
    viewport,
    transform,
    fitAll,
    reset,
    focusNode,
    zoomIn,
    zoomOut,
    onDoubleClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useWorkflowCanvas(layout, { minScale: 0.18, maxScale: 2.5, padding: 32, anchor: anchorNode });

  const visibleNodes = layout.nodes;
  const svgKeyboardNavigation = visibleNodes.length <= 62;
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = layout.edges;
  const visibleSelectedNode = selectedNode && visibleIds.has(selectedNode.id) ? selectedNode : null;
  const visibleHoveredNode = hoveredNode && visibleIds.has(hoveredNode.id) ? hoveredNode : null;
  const activeNode = visibleSelectedNode || visibleHoveredNode;
  const connectedEdges = useMemo(() => {
    if (!activeNode) return new Set<string>();
    return new Set(visibleEdges
      .filter((edge) => edge.from === activeNode.id || edge.to === activeNode.id)
      .map((edge) => `${edge.from}->${edge.to}`));
  }, [activeNode, visibleEdges]);
  const triggerNode = visibleNodes.find((node) => node.category === 'trigger');
  // A single node has nothing to connect, so silence there is correct.
  const hasNoResolvableEdges = visibleEdges.length === 0 && visibleNodes.length > 1;
  // Dropped edges are no longer in `edges`, so both halves count (CI R-2).
  const declaredEdgeCount = chart.edges.length + (chart.unresolvedEdgeCount ?? 0);
  const ariaLabel = `Workflow diagram${entryTitle ? ` for ${entryTitle}` : ''} with ${visibleNodes.length} nodes${triggerNode ? `, trigger: ${triggerNode.name}` : ''}`;

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    fullscreenButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const overlay = fullscreenRef.current;
      if (!overlay) return;
      const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]'))
        .filter((element) => {
          const details = element.closest('details');
          return !details || details.open || element.tagName === 'SUMMARY';
        });
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!overlay.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      fullscreenOpenerRef.current?.focus();
    };
  }, [isFullscreen]);

  const toggleFullscreen = () => {
    if (!isFullscreen) fullscreenOpenerRef.current = document.activeElement as HTMLElement | null;
    setIsFullscreen((value) => !value);
  };
  const activateFromList = (node: LayoutNode) => {
    setSelectedNode(node);
    focusNode(node);
  };
  const svgWidth = Math.max(1, viewport.width);
  const svgHeight = Math.max(1, viewport.height);
  const chartClass = isFullscreen
    ? 'fixed inset-0 z-50 flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-page p-2 sm:p-4'
    : 'relative min-w-0 max-w-full overflow-hidden rounded-panel border border-hairline bg-panel';
  const viewportClass = isFullscreen
    ? 'relative min-h-0 w-full max-w-full flex-1 overflow-hidden bg-page'
    : 'relative h-72 w-full max-w-full overflow-hidden bg-page sm:h-80 lg:h-[440px]';

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3">
      <section ref={fullscreenRef} data-testid="workflow-chart" aria-label="Interactive workflow canvas" className={chartClass}>
        <ChartControls
          scale={transform.scale}
          nodeCount={visibleNodes.length}
          edgeCount={visibleEdges.length}
          hasTrigger={Boolean(triggerNode)}
          isFullscreen={isFullscreen}
          showAnnotations={showAnnotations}
          fullscreenButtonRef={fullscreenButtonRef}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFit={fitAll}
          onFocusTrigger={() => triggerNode && focusNode(triggerNode)}
          onReset={reset}
          onToggleAnnotations={() => setShowAnnotations((value) => !value)}
          onToggleFullscreen={toggleFullscreen}
        />
        <div
          ref={containerRef}
          data-testid="workflow-canvas-viewport"
          className={viewportClass}
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDoubleClick={onDoubleClick}
        >
          {/* Deliberately NOT role="img": that makes the element a leaf in the
              accessibility tree, so assistive technology reads the label and
              discards the subtree — including every focusable node inside it.
              `group` keeps the nodes reachable; <title>/<desc> still carry the
              summary for anyone who wants the shape rather than the parts. */}
          <svg
            role="group"
            aria-label={ariaLabel}
            aria-roledescription="Workflow diagram"
            width={svgWidth}
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="block h-full w-full max-w-full cursor-grab select-none overflow-hidden active:cursor-grabbing"
          >
            <title>{ariaLabel}</title>
            <desc>Interactive workflow graph. Use the controls above or the node list below to inspect nodes.</desc>
            <ChartDefs scale={transform.scale} />
            <rect width={svgWidth} height={svgHeight} fill="url(#wf-grid-dots)" />
            <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
              {visibleEdges.map((edge, index) => {
                const key = `${edge.from}->${edge.to}`;
                return <ChartEdgeItem key={`edge-${index}-${key}`} edge={edge} isHighlighted={connectedEdges.has(key)} isDimmed={activeNode !== null && !connectedEdges.has(key)} />;
              })}
              {visibleNodes.map((node) => {
                const isConnected = activeNode && (activeNode.id === node.id || connectedEdges.has(`${activeNode.id}->${node.id}`) || connectedEdges.has(`${node.id}->${activeNode.id}`));
                return <ChartNodeItem key={node.id} node={node} scale={transform.scale} isSelected={visibleSelectedNode?.id === node.id} isHovered={visibleHoveredNode?.id === node.id} isDimmed={Boolean(activeNode && !isConnected)} keyboardNavigable={svgKeyboardNavigation} onSelect={(next) => setSelectedNode((current) => current?.id === next.id ? null : next)} onHover={setHoveredNode} />;
              })}
            </g>
          </svg>
          <ChartInspector node={visibleSelectedNode} layout={{ ...layout, nodes: visibleNodes, edges: visibleEdges }} onSelectNode={setSelectedNode} onClose={() => setSelectedNode(null)} />
          {/* Nodes with no arrows read as a broken canvas; for 13.27% of the
              catalogue it is the upstream file that is broken (CV-2a). */}
          {hasNoResolvableEdges && (
            <p role="status" aria-label="Connection information" className="pointer-events-none absolute inset-x-3 bottom-3 rounded-control border border-hairline bg-panel/95 px-3 py-2 text-center font-mono text-2xs leading-5 text-ink-muted">
              No connections could be resolved for this workflow.
              {declaredEdgeCount > 0 ? ` The upstream file declares ${declaredEdgeCount} that do not match any node in it.` : ' The upstream file declares none.'}
            </p>
          )}
        </div>
        <ChartNodeList nodes={visibleNodes} edges={visibleEdges} selectedNodeId={visibleSelectedNode?.id} onActivate={activateFromList} />
      </section>
    </div>
  );
}
