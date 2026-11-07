// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphLayout, LayoutNode } from '@hub/contracts';
import { ChartInspector } from './chart-inspector';

afterEach(() => cleanup());

const node = (id: string, name = id): LayoutNode => ({
  id, name, type: 'n8n-nodes-base.noOp', category: 'other', x: 0, y: 0, width: 140, height: 44,
});
const selected = node('selected', 'Selected');
const incoming = Array.from({ length: 20 }, (_, index) => node(`in-${index}`, `Input ${index}`));
const outgoing = Array.from({ length: 20 }, (_, index) => node(`out-${index}`, `Output ${index}`));
const layout: GraphLayout = {
  width: 1,
  height: 1,
  viewBox: '0 0 1 1',
  nodes: [selected, ...incoming, ...outgoing],
  edges: [
    ...incoming.map((entry) => ({ from: entry.id, to: selected.id, kind: 'main' as const, pathD: '' })),
    ...outgoing.map((entry) => ({ from: selected.id, to: entry.id, kind: 'main' as const, pathD: '' })),
  ],
};

describe('ChartInspector', () => {
  it('bounds large input and output neighbor lists', () => {
    render(<ChartInspector node={selected} layout={layout} onSelectNode={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: /Input \d/ })).toHaveLength(12);
    expect(screen.getAllByRole('button', { name: /Output \d/ })).toHaveLength(12);
    expect(screen.getByRole('button', { name: /Show 8 more input nodes/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Show 8 more output nodes/ })).toBeDefined();
  });

  it('expands only the requested neighbor direction', () => {
    render(<ChartInspector node={selected} layout={layout} onSelectNode={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Show 8 more input nodes/ }));
    expect(screen.getAllByRole('button', { name: /Input \d/ })).toHaveLength(20);
    expect(screen.getAllByRole('button', { name: /Output \d/ })).toHaveLength(12);
    expect(screen.queryByRole('button', { name: /Show .* input nodes/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Show 8 more output nodes/ })).toBeDefined();
  });
});
