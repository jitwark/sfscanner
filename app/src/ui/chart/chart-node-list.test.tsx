// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutEdge, LayoutNode } from '@hub/contracts';
import { ChartNodeList } from './chart-node-list';

afterEach(() => cleanup());

const nodes: LayoutNode[] = Array.from({ length: 95 }, (_, index) => ({
  id: `node-${index}`,
  name: `Node ${index}`,
  type: 'n8n-nodes-base.noOp',
  category: 'other',
  x: index * 10,
  y: 0,
  width: 140,
  height: 44,
}));
const edges: LayoutEdge[] = [];

describe('ChartNodeList', () => {
  it('mounts a bounded initial window and reports the remaining nodes', () => {
    render(<ChartNodeList nodes={nodes} edges={edges} onActivate={vi.fn()} />);

    fireEvent.click(screen.getByText(/View workflow node list/));
    expect(screen.getAllByRole('button', { name: /Focus .* node/ })).toHaveLength(40);
    expect(screen.getByRole('button', { name: /Show 40 more nodes/ })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('55 additional nodes are available');
  });

  it('keeps the selected node visible even when it is outside the window', () => {
    render(<ChartNodeList nodes={nodes} edges={edges} selectedNodeId="node-94" onActivate={vi.fn()} />);

    fireEvent.click(screen.getByText(/View workflow node list/));
    expect(screen.getByRole('button', { name: 'Focus Node 94 node' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: /Focus .* node/ })).toHaveLength(41);
  });

  it('keeps an off-window selected node keyboard-focusable and activatable', () => {
    const onActivate = vi.fn();
    render(<ChartNodeList nodes={nodes} edges={edges} selectedNodeId="node-94" onActivate={onActivate} />);

    fireEvent.click(screen.getByText(/View workflow node list/));
    const selected = screen.getByRole('button', { name: 'Focus Node 94 node' });

    selected.focus();
    expect(document.activeElement).toBe(selected);
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(selected.getAttribute('type')).toBe('button');

    // jsdom does not synthesize a native button click for Enter/Space key
    // events; the semantic button and focus assertions above cover the
    // keyboard route, while this verifies the same focused item activates.
    fireEvent.click(selected);
    expect(onActivate).toHaveBeenCalledWith(nodes[94]);
  });

  it('expands by a fixed window and removes the action at the end', () => {
    render(<ChartNodeList nodes={nodes} edges={edges} onActivate={vi.fn()} />);

    fireEvent.click(screen.getByText(/View workflow node list/));
    fireEvent.click(screen.getByRole('button', { name: /Show 40 more nodes/ }));
    expect(screen.getAllByRole('button', { name: /Focus .* node/ })).toHaveLength(80);
    expect(screen.getByRole('button', { name: /Show 15 more nodes/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Show 15 more nodes/ }));
    expect(screen.getAllByRole('button', { name: /Focus .* node/ })).toHaveLength(95);
    expect(screen.queryByRole('button', { name: /Show .* more nodes/ })).toBeNull();
  });
});
