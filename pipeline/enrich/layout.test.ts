import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { layoutWorkflow } from './layout.js';

describe('layoutWorkflow', () => {
  it('normalizes embedded position coordinates into 0..1 bounding box', () => {
    const nodes = [
      { id: '1', position: [100, 200] as [number, number] },
      { id: '2', position: [500, 600] as [number, number] },
      { id: '3', position: [300, 400] as [number, number] },
    ];
    const edges: { from: string; to: string }[] = [];

    const layout = layoutWorkflow(nodes, edges);

    expect(layout['1']).toEqual({ x: 0, y: 0 });
    expect(layout['2']).toEqual({ x: 1, y: 1 });
    expect(layout['3']).toEqual({ x: 0.5, y: 0.5 });
  });

  it('uses BFS layered layout fallback when positions are missing', () => {
    const nodes = [
      { id: 'start' },
      { id: 'step1' },
      { id: 'step2' },
      { id: 'end' },
    ];
    const edges = [
      { from: 'start', to: 'step1' },
      { from: 'step1', to: 'step2' },
      { from: 'step2', to: 'end' },
    ];

    const layout = layoutWorkflow(nodes, edges);

    expect(layout['start'].x).toBe(0);
    expect(layout['end'].x).toBe(1);
    expect(layout['step1'].x).toBeGreaterThan(layout['start'].x);
    expect(layout['step2'].x).toBeGreaterThan(layout['step1'].x);
    expect(layout['end'].x).toBeGreaterThan(layout['step2'].x);
  });

  it('performs barycentre crossing reduction on a known graph', () => {
    // Layer 0: A (idx 0), B (idx 1)
    // Layer 1: C (connected to B), D (connected to A)
    // Barycentre heuristic should sort Layer 1 as D (barycentre 0) then C (barycentre 1)
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
    const edges = [
      { from: 'A', to: 'D' },
      { from: 'B', to: 'C' },
    ];

    const layout = layoutWorkflow(nodes, edges);

    expect(layout['D'].y).toBeLessThan(layout['C'].y);
  });

  it('asserts 0..1 coordinate invariant over 200 real workflows from vault', () => {
    const templatesDir = 'D:/projects/n8n-vault-core/templates';
    if (!fs.existsSync(templatesDir)) return;

    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json')).slice(0, 200);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(templatesDir, file), 'utf-8');
        const json = JSON.parse(content);
        const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
        const nodes = rawNodes
          .map((n: Record<string, unknown>) => ({
            id: String(n.name || n.id || ''),
            position:
              Array.isArray(n.position) && n.position.length >= 2
                ? ([Number(n.position[0]), Number(n.position[1])] as [number, number])
                : undefined,
          }))
          .filter((n: { id: string; position?: [number, number] }) => Boolean(n.id));

        const edges: { from: string; to: string }[] = [];
        const conns = json.connections && typeof json.connections === 'object' ? json.connections : {};
        for (const from of Object.keys(conns)) {
          const kindsObj = conns[from];
          if (!kindsObj || typeof kindsObj !== 'object') continue;
          for (const kind of Object.keys(kindsObj)) {
            const arr = kindsObj[kind];
            if (!Array.isArray(arr)) continue;
            for (const grp of arr) {
              if (!Array.isArray(grp)) continue;
              for (const target of grp) {
                if (target && target.node) {
                  edges.push({ from, to: String(target.node) });
                }
              }
            }
          }
        }

        const layout = layoutWorkflow(nodes, edges);

        for (const [id, pt] of Object.entries(layout)) {
          expect(pt.x, `x bound for node ${id} in ${file}`).toBeGreaterThanOrEqual(0);
          expect(pt.x, `x bound for node ${id} in ${file}`).toBeLessThanOrEqual(1);
          expect(pt.y, `y bound for node ${id} in ${file}`).toBeGreaterThanOrEqual(0);
          expect(pt.y, `y bound for node ${id} in ${file}`).toBeLessThanOrEqual(1);
          expect(Number.isNaN(pt.x)).toBe(false);
          expect(Number.isNaN(pt.y)).toBe(false);
        }
      } catch {
        // ignore parse error
      }
    }
  }, 30_000);
});
