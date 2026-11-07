import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditClientBoundaries, renderInventoryReport } from './audit-client-boundaries.mjs';

const roots = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'client-boundary-audit-'));
  const files = {
    'app/app/layout.tsx': "import { Inter } from 'next/font/google'; export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    'app/app/page.tsx': "import { Client } from '@/src/ui/client'; import { IdleData } from '@/src/ui/idle-data'; import { Viewport } from '@/src/ui/viewport'; import { Image } from '@/src/ui/image'; import { Chart } from '@/src/ui/chart/chart'; import { runScan } from '@/src/scanner/run-scan'; export default function Page() { runScan; return <><Client /><IdleData /><Viewport /><Image /><Chart /></>; }",
    'app/src/ui/client.tsx': "'use client'; export function Client() { return <button onClick={() => void import('./click-panel')}>Open</button>; }",
    'app/src/ui/idle-data.tsx': "'use client'; export function IdleData() { window.requestIdleCallback(() => fetch('/data/search-index.json')); return null; }",
    'app/src/ui/viewport.tsx': "'use client'; export function Viewport() { new IntersectionObserver(() => void import('./viewport-panel')).observe(document.body); return null; }",
    'app/src/ui/image.tsx': "export function Image() { return <img src='/logo.png' alt='Logo' />; }",
    'app/src/ui/chart/chart.tsx': "'use client'; export function Chart() { return <svg aria-label='chart' />; }",
    'app/src/ui/click-panel.tsx': "export function ClickPanel() { return null; }",
    'app/src/ui/viewport-panel.tsx': "export function ViewportPanel() { return null; }",
    'app/src/scanner/run-scan.ts': "export function runScan() { return new Worker(new URL('./scan.worker.ts', import.meta.url)); }",
    'app/src/ui/dead.tsx': "'use client'; export function Dead() { return null; }",
  };
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source, 'utf8');
  }
  roots.push(root);
  return root;
}

function find(inventory, kind, target) {
  const item = inventory.findings.find((candidate) => candidate.kind === kind && (!target || candidate.target === target));
  expect(item, `missing ${kind} ${target}; got ${JSON.stringify(inventory.findings)}`).toBeTruthy();
  return item;
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop(), { recursive: true, force: true });
  }
});

describe('client-boundary inventory', () => {
  it('builds a route-aware inventory and classifies statically provable triggers', async () => {
    const root = await fixture();
    const inventory = await auditClientBoundaries(root);
    expect(inventory.routeEntrypoints.map((entry) => entry.route)).toEqual(['/']);
    expect(find(inventory, 'client-boundary', 'app/src/ui/client.tsx').classification).toBe('critical');
    expect(find(inventory, 'dynamic-import', './click-panel').classification).toBe('user-triggered');
    expect(find(inventory, 'dynamic-import', './viewport-panel').classification).toBe('viewport-triggered');
    expect(find(inventory, 'data-request', '/data/search-index.json').classification).toBe('idle');
    expect(find(inventory, 'font', 'next/font/google').classification).toBe('critical');
    expect(find(inventory, 'image', '/logo.png').classification).toBe('critical');
    expect(find(inventory, 'chart').classification).toBe('critical');
    expect(find(inventory, 'worker', './scan.worker.ts').classification).toBe('user-triggered');
    expect(find(inventory, 'client-boundary', 'app/src/ui/dead.tsx').classification).toBe('never');
    expect(find(inventory, 'dynamic-import', './click-panel').routes).toContain('/');

    const report = renderInventoryReport(inventory);
    expect(report).toMatch(/Static evidence/);
    expect(report).toMatch(/deployed\/browser evidence/i);
    expect(report).toMatch(/viewport-triggered/);
  });
});
