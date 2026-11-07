import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SvgPreviewArtifact } from '@hub/contracts';
import { StaticWorkflowPreview } from './static-preview';

afterEach(() => cleanup());

const preview: SvgPreviewArtifact = {
  schemaVersion: 'svg-preview-v1', tier: 'C',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" role="img"><title>Workflow diagram</title><rect x="1" y="1" width="10" height="10" fill="#22c55e" stroke="#22c55e" /></svg>',
  nodeList: [
    { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' },
    { id: 'b', name: 'Send', type: 'n8n-nodes-base.httpRequest', category: 'http' },
  ],
  contentHash: 'a'.repeat(64), unresolvedEdgeCount: 2,
};

describe('StaticWorkflowPreview', () => {
  it('renders the trusted SVG and a complete keyboard-accessible node fallback', () => {
    const { container } = render(<StaticWorkflowPreview preview={preview} />);
    expect(container.querySelector('[data-static-preview] svg')).not.toBeNull();
    const nodeList = screen.getByLabelText('Workflow node list');
    expect(nodeList.textContent).toMatch(/Start/);
    expect(nodeList.textContent).toMatch(/Send/);
    expect(screen.getByText(/2 declared connections could not be resolved/i)).toBeTruthy();
    const summary = container.querySelector('summary');
    expect(summary?.textContent).toMatch(/view all workflow nodes/i);
  });

  it('exposes the labeled preview as one atomic image to assistive technology', () => {
    const { container } = render(<StaticWorkflowPreview preview={preview} />);

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Workflow diagram, tier C, 2 nodes' })).toBeTruthy();
    expect(container.querySelector('[data-static-preview] svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-static-preview] svg')?.getAttribute('focusable')).toBe('false');
  });

  it('does not add an interactive canvas control to the static preview', () => {
    const { container } = render(<StaticWorkflowPreview preview={preview} />);
    expect(container.querySelector('[data-interactive-canvas]')).toBeNull();
    expect(screen.queryByRole('button', { name: /explore interactive canvas/i })).toBeNull();
  });

  it('renders only local vector elements without attributes that can trigger remote loads', () => {
    const { container } = render(<StaticWorkflowPreview preview={preview} />);
    const svg = container.querySelector('[data-static-preview] svg');
    const elements = [svg, ...Array.from(svg?.querySelectorAll('*') ?? [])].filter((node): node is Element => node !== null);
    const attributeNames = elements.flatMap((element) => Array.from(element.attributes, (attribute) => attribute.name));

    expect(elements.some((element) => /^(script|foreignobject|iframe|object|embed|image|use|style|animate|set|a)$/i.test(element.localName))).toBe(false);
    expect(attributeNames.some((name) => /^(href|xlink:href|src|style|on[a-z])/i.test(name))).toBe(false);
  });

  it('removes a serialized root tabindex so the SVG cannot add a duplicate focus target', () => {
    const focusableRoot: SvgPreviewArtifact = {
      ...preview,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" role="img" tabindex="0"><title>Workflow diagram</title></svg>',
    };

    const { container } = render(<StaticWorkflowPreview preview={focusableRoot} />);

    expect(container.querySelector('[data-static-preview] svg')?.getAttribute('tabindex')).toBeNull();
  });

  it('uses an accessible unnamed-node fallback without inventing a zero-edge warning', () => {
    const unnamed: SvgPreviewArtifact = {
      ...preview,
      tier: 'A',
      nodeList: [{ id: 'unnamed', name: '', type: 'n8n-nodes-base.noOp', category: 'other' }],
      unresolvedEdgeCount: 0,
    };

    render(<StaticWorkflowPreview preview={unnamed} />);

    expect(screen.getByRole('img', { name: 'Workflow diagram, tier A, 1 nodes' })).toBeTruthy();
    expect(screen.getByLabelText('Workflow node list').textContent).toBe('Unnamed node — n8n-nodes-base.noOp');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces the finite invalid-tier fallback instead of an empty diagram', () => {
    const invalid: SvgPreviewArtifact = {
      ...preview,
      tier: 'invalid',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" role="img"><text>No diagram is available for this workflow.</text></svg>',
      nodeList: [],
      unresolvedEdgeCount: 0,
    };

    const { container } = render(<StaticWorkflowPreview preview={invalid} />);

    expect(screen.getByRole('img', { name: 'Workflow diagram unavailable, tier invalid, 0 nodes' })).toBeTruthy();
    expect(container.querySelector('[data-static-preview]')?.textContent).toContain('No diagram is available for this workflow.');
    expect(screen.getByText('Tier invalid')).toBeTruthy();
    expect(screen.getByText('0 workflow nodes')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
