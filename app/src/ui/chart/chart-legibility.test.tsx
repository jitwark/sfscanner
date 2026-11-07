// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartDefs } from './chart-defs';
import { ChartEdgeItem } from './chart-edge-item';
import { ChartNodeItem } from './chart-node-item';
import { compactCoordinates } from '@hub/contracts';

/**
 * CV-2b and CV-3 (audit 2026-08-25).
 *
 * Edges were stroked at 1.75 and arrowheads sized `markerWidth=6` with the
 * default `markerUnits="strokeWidth"`, both inside `<g transform="scale(...)">`.
 * Measured over the corpus, the fitted scale is 0.335 at the median and 9.7% of
 * charts sit at the 0.18 floor — so the connecting line rendered at **0.59 CSS
 * pixels** on a median chart. Below the threshold at which a browser paints a
 * solid line, which is why arrows looked absent on graphs whose data was fine.
 *
 * These assert **on-screen size**, not attribute presence. `markerUnits` being
 * set says nothing about how big the arrowhead ends up.
 */

afterEach(() => cleanup());

const svg = (children: React.ReactNode) =>
  render(createElement('svg', null, children)).container.querySelector('svg')!;

describe('edge legibility under zoom', () => {
  const edge = { from: 'a', to: 'b', kind: 'main', pathD: 'M 0 0 C 10 0, 20 10, 30 10' };

  it('holds the stroke at a constant device width however far out the reader is zoomed', () => {
    const root = svg(createElement(ChartEdgeItem, { edge, isHighlighted: false, isDimmed: false }));
    const paths = Array.from(root.querySelectorAll('path'));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  /**
   * `markerUnits="userSpaceOnUse"` alone makes this worse, not better: the
   * marker stops scaling with stroke-width but still scales with the group
   * transform, so it shrinks from 10.5 user units to 6. The size has to be
   * compensated by 1/scale for the arrowhead to hold its on-screen size.
   */
  it.each([0.18, 0.335, 1])('keeps the arrowhead a legible size at scale %s', (scale) => {
    const root = svg(createElement(ChartDefs, { scale }));
    const marker = root.querySelector('#wf-arrow')!;
    expect(marker.getAttribute('markerUnits')).toBe('userSpaceOnUse');

    const onScreen = Number(marker.getAttribute('markerWidth')) * scale;
    expect(onScreen).toBeGreaterThanOrEqual(6);
    expect(onScreen).toBeLessThanOrEqual(14);
  });

  it('anchors the arrow tip in viewBox units, so it stays on the line end', () => {
    const root = svg(createElement(ChartDefs, { scale: 0.18 }));
    for (const id of ['#wf-arrow', '#wf-arrow-active']) {
      const marker = root.querySelector(id)!;
      // refX/refY are in the marker's own coordinate system, which `viewBox`
      // defines — they must not be rescaled alongside markerWidth.
      expect(marker.getAttribute('viewBox')).toBe('0 0 10 10');
      expect(marker.getAttribute('refX')).toBe('8');
      expect(marker.getAttribute('refY')).toBe('5');
    }
  });
});

describe('chart node contrast', () => {
  it('keeps labels opaque and uses categorical colors while unrelated nodes are dimmed', () => {
    const node = {
      id: 'http', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest',
      category: 'http' as const, x: 0, y: 0, width: 140, height: 44,
    };
    const root = svg(createElement(ChartNodeItem, {
      node,
      scale: 1,
      isSelected: false,
      isHovered: false,
      isDimmed: true,
      onSelect: () => {},
      onHover: () => {},
    }));
    const group = root.querySelector('[data-node-id="http"]')!;
    const text = Array.from(group.querySelectorAll('text'));
    const categoryLabel = text.find((element) => element.textContent === 'HTTP / API');
    const categoryTag = Array.from(group.querySelectorAll('rect')).at(-1);

    expect(group.hasAttribute('opacity')).toBe(false);
    expect(text.every((element) => !element.hasAttribute('opacity'))).toBe(true);
    expect(group.querySelector('rect')?.getAttribute('opacity')).toBe('0.35');
    expect(categoryLabel?.getAttribute('fill')).toBe('var(--color-cat-green)');
    expect(categoryTag?.getAttribute('stroke')).toBe('var(--color-cat-green)');

    const codeRoot = svg(createElement(ChartNodeItem, {
      node: { ...node, id: 'code', category: 'code', type: 'n8n-nodes-base.code' },
      scale: 1,
      isSelected: false,
      isHovered: false,
      isDimmed: false,
      onSelect: () => {},
      onHover: () => {},
    }));
    const codeLabel = Array.from(codeRoot.querySelectorAll('text'))
      .find((element) => element.textContent === 'CODE');
    expect(codeLabel?.getAttribute('fill')).toBe('var(--color-cat-orange)');
  });
});

/**
 * CV-3. `compactAxis` clamped the *maximum* distance between distinct
 * coordinates and said nothing about the minimum, while the renderer draws
 * fixed 140x44 boxes. Two nodes 40 editor-units apart on x stayed 40 apart and
 * overlapped by 100px. Measured over 13,221 charts: 13.58% had at least one
 * overlapping pair; with a minimum gap that falls to 0.28%.
 */
describe('compactCoordinates', () => {
  it('never places two distinct columns closer than a node is wide', () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }];
    const laid = compactCoordinates(points, { maxXGap: 200, maxYGap: 70, minXGap: 164, minYGap: 60 });
    expect(laid[1]!.x - laid[0]!.x).toBeGreaterThanOrEqual(164);
    expect(laid[2]!.x - laid[1]!.x).toBeGreaterThanOrEqual(164);
  });

  it('never places two distinct rows closer than a node is tall', () => {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 30 }];
    const laid = compactCoordinates(points, { maxXGap: 200, maxYGap: 70, minXGap: 164, minYGap: 60 });
    expect(laid[1]!.y - laid[0]!.y).toBeGreaterThanOrEqual(60);
  });

  it('still collapses a sprawling gap rather than preserving it', () => {
    const points = [{ x: 0, y: 0 }, { x: 5000, y: 0 }];
    const laid = compactCoordinates(points, { maxXGap: 200, maxYGap: 70, minXGap: 164, minYGap: 60 });
    expect(laid[1]!.x - laid[0]!.x).toBe(200);
  });

  it('still snaps editor jitter onto a shared line', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 0 }];
    const laid = compactCoordinates(points, { maxXGap: 200, maxYGap: 70, minXGap: 164, minYGap: 60 });
    expect(laid[1]!.x).toBe(laid[0]!.x);
  });

  it('keeps working for callers that set no minimum', () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
    const laid = compactCoordinates(points, { maxXGap: 200, maxYGap: 70 });
    expect(laid[1]!.x - laid[0]!.x).toBe(40);
  });
});
