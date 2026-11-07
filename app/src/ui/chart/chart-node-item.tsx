'use client';

import React, { useState } from 'react';
import type { LayoutNode, NodeCategory } from '@hub/contracts';
import { NodeIcon } from './chart-icons';
import { moveKeyboardFocus } from './keyboard-navigation';

// Categorical, not ordered: "different kind", never "worse", each paired with
// its written label. `text` is separate from `accent` because amber is 1.51:1
// on white — right as the trigger's ring, unreadable as its caption.
const CATEGORY_COLORS: Record<NodeCategory, { border: string; accent: string; text: string; label: string }> = {
  trigger: { border: 'var(--color-accent-border)', accent: 'var(--color-accent)', text: 'var(--color-accent-text)', label: 'TRIGGER' },
  ai: { border: 'var(--color-cat-purple)', accent: 'var(--color-cat-purple)', text: 'var(--color-cat-purple)', label: 'AI / LLM' },
  http: { border: 'var(--color-cat-green)', accent: 'var(--color-cat-green)', text: 'var(--color-cat-green)', label: 'HTTP / API' },
  code: { border: 'var(--color-cat-orange)', accent: 'var(--color-cat-orange)', text: 'var(--color-cat-orange)', label: 'CODE' },
  storage: { border: 'var(--color-cat-blue)', accent: 'var(--color-cat-blue)', text: 'var(--color-cat-blue)', label: 'DATA' },
  flow: { border: 'var(--color-ink-muted)', accent: 'var(--color-ink-muted)', text: 'var(--color-ink-muted)', label: 'LOGIC' },
  transform: { border: 'var(--color-cat-pink)', accent: 'var(--color-cat-pink)', text: 'var(--color-cat-pink)', label: 'TRANSFORM' },
  other: { border: 'var(--color-ink-faint)', accent: 'var(--color-ink-faint)', text: 'var(--color-ink-faint)', label: 'NODE' },
};

/** WCAG 2.5.8 (AA) minimum pointer target, in CSS pixels. */
const MIN_POINTER_TARGET_PX = 24;
type ChartNodeItemProps = {
  node: LayoutNode;
  scale: number;
  isSelected: boolean;
  isHovered: boolean;
  isDimmed: boolean;
  keyboardNavigable?: boolean;
  onSelect: (node: LayoutNode) => void;
  onHover: (node: LayoutNode | null, e?: React.MouseEvent) => void;
};

export function ChartNodeItem({
  node,
  scale,
  isSelected,
  isHovered,
  isDimmed,
  keyboardNavigable = true,
  onSelect,
  onHover,
}: ChartNodeItemProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const cat = CATEGORY_COLORS[node.category] || CATEGORY_COLORS.other;
  const shortType = node.type.split('.').pop() || node.type;
  const label = node.name.length > 15 ? `${node.name.slice(0, 13)}…` : node.name;

  // Interactivity is independent of scale; rendered size controls hit padding,
  // never whether a node remains keyboard and assistive-technology accessible.
  const renderedHeight = node.height * scale;
  const renderedWidth = node.width * scale;
  const needsHitPadding = renderedHeight < MIN_POINTER_TARGET_PX;
  const showLabel = renderedHeight >= 18 && renderedWidth >= 74;
  const hasPressedTreatment = isPressed;
  const strokeColor = isSelected || isFocused ? 'var(--color-accent-border)' : isHovered ? cat.border : 'var(--color-hairline-strong)';
  const strokeWidth = isSelected || isFocused ? 2.5 : isHovered ? 2 : 1;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      data-node-id={node.id}
      data-interactive="true"
      aria-hidden={keyboardNavigable ? undefined : true}
      pointerEvents="auto"
      className="cursor-pointer transition-opacity duration-150"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node);
      }}
      onMouseEnter={(e) => onHover(node, e)}
      onMouseLeave={() => onHover(null)}
      role={keyboardNavigable ? 'button' : undefined}
      tabIndex={keyboardNavigable ? 0 : undefined}
      aria-label={keyboardNavigable ? `Node: ${node.name} (${node.category})` : undefined}
      aria-pressed={keyboardNavigable ? isSelected : undefined}
      data-focused={isFocused}
      data-pressed={hasPressedTreatment}
      data-selected={isSelected}
      onPointerDown={() => setIsPressed(true)}
      onPointerUp={() => setIsPressed(false)}
      onPointerCancel={() => setIsPressed(false)}
      onPointerLeave={() => setIsPressed(false)}
      onFocus={keyboardNavigable ? () => setIsFocused(true) : undefined}
      onBlur={keyboardNavigable ? () => {
        setIsFocused(false);
        setIsPressed(false);
      } : undefined}
      onKeyDown={keyboardNavigable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node);
          return;
        }
        moveKeyboardFocus(e);
      } : undefined}
    >
      {/* Zoomed out far enough that the card is under the minimum pointer
          target, an invisible rect restores a 24px hit area in SCREEN space.
          Dividing by scale converts CSS pixels back into world units. */}
      {needsHitPadding && (
        <rect
          x={(node.width - MIN_POINTER_TARGET_PX / scale) / 2}
          y={(node.height - MIN_POINTER_TARGET_PX / scale) / 2}
          width={MIN_POINTER_TARGET_PX / scale}
          height={MIN_POINTER_TARGET_PX / scale}
          fill="transparent"
        />
      )}

      {/* Node Card Background */}
      <rect
        width={node.width}
        height={node.height}
        rx={2}
        ry={2}
        opacity={isDimmed ? 0.35 : 1}
        fill={hasPressedTreatment ? 'var(--color-accent-dim)' : 'var(--color-panel)'}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        filter={isSelected || isFocused || isHovered || hasPressedTreatment ? 'url(#wf-glow)' : undefined}
      />

      {/* Left Category Accent Strip */}
      <rect
        x={2}
        y={2}
        width={3.5}
        height={node.height - 4}
        rx={2}
        opacity={isDimmed ? 0.35 : 1}
        fill={cat.accent}
      />

      {/* Icon Pill Area */}
      <foreignObject x={9} y={8} width={22} height={22} opacity={isDimmed ? 0.35 : 1}>
        <div className="flex h-full w-full items-center justify-center rounded-control bg-page/80 text-ink">
          <NodeIcon category={node.category} type={node.type} className="w-3.5 h-3.5" />
        </div>
      </foreignObject>

      {/* Node Label & Subtitle */}
      {showLabel && (
        <>
          <text
            x={35}
            y={20}
            fontSize={11}
            fontWeight="600"
            fontFamily="var(--font-sans), sans-serif"
            fill="var(--color-ink)"
            className="select-none"
            data-node-label={node.id}
          >
            {label}
          </text>
          <text
            x={35}
            y={33}
            fontSize={8.5}
            fontFamily="var(--font-mono), monospace"
            fill="var(--color-ink-muted)"
            className="select-none"
          >
            {shortType.length > 14 ? `${shortType.slice(0, 12)}…` : shortType}
          </text>
        </>
      )}

      {/* Category Pill Tag */}
      <rect
        x={node.width - 46}
        y={4}
        width={42}
        height={13}
        rx={2}
        fill="var(--color-raised)"
        fillOpacity={isDimmed ? 0.3 : 0.85}
        stroke={cat.border}
        strokeWidth={0.75}
      />
      <text
        x={node.width - 25}
        y={13}
        textAnchor="middle"
        fontSize={7}
        fontWeight="700"
        fontFamily="var(--font-mono), monospace"
        fill={cat.text}
        className="select-none"
      >
        {cat.label}
      </text>
    </g>
  );
}
