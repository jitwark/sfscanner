import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { LayoutWorkbench } from './layout-workbench';

afterEach(() => cleanup());

function makeEntry(): Entry {
  return {
    id: 'workbench-1',
    slug: 'workbench-test',
    title: 'Workbench Workflow',
    summary: 'A dense studio workflow summary.',
    description: 'Full description of workbench workflow.',
    descriptionSource: 'upstream',
    source: {
      kind: 'n8n_official',
      permalink: 'https://n8n.io/2',
      fetchedAt: '2026-08-01',
      author: { name: 'n8n Team' },
    },
    rights: { status: 'redistributable', licence: 'MIT', licenceUrl: null, reason: 'Repository licence: MIT' },
    security: {
      grade: 'LOW',
      score: 95,
      findings: [{ id: 'sec-1', title: 'Webhook Auth Check', severity: 'INFO', why: 'Info check', fix: 'Add auth' }],
      hardenedExtra: 0,
      scannerVersion: '1',
      profile: 'beta-default',
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
    },
    structure: {
      nodeCount: 6,
      rawNodeCount: 6,
      annotationNodeCount: 0,
      connectionCount: 7,
      complexity: 'simple',
      trigger: 'Webhook',
      integrations: ['webhook'],
      nodeTypes: ['webhook'],
      isSubWorkflow: false,
      hasCode: false,
      hasAI: false,
      hasWebhook: true,
    },
    tags: ['webhook'],
    dedup: { fingerprint: 'fp', structuralHash: 'sh', canonical: true, alsoFoundIn: [] },
  };
}

const FIXTURE_PREVIEW: SvgPreviewArtifact = {
  schemaVersion: 'svg-preview-v1',
  tier: 'A',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect/></svg>',
  nodeList: [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', category: 'trigger' }],
  contentHash: 'c'.repeat(64),
  unresolvedEdgeCount: 0,
};

describe('LayoutWorkbench', () => {
  it('keeps the current detail breadcrumb a label when the slug needs encoding', () => {
    const entry = makeEntry();
    entry.slug = 'folder/name?one';
    const { container } = render(<LayoutWorkbench entry={entry} />);

    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(entry.title);
    expect(container.querySelector('a[href^="/w/folder/"]')).toBeNull();
  });

  it('renders about section, provenance, uncollapsed readiness, security, and vector diagram', () => {
    render(<LayoutWorkbench entry={makeEntry()} preview={FIXTURE_PREVIEW} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Workbench Workflow' })).toBeTruthy();
    expect(screen.getByText('About this workflow')).toBeTruthy();
    expect(screen.getByText('Provenance & Trust')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Workflow canvas' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Before you run' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Security summary' })).toBeTruthy();
    expect(screen.getByText(/Webhook Auth Check/i)).toBeTruthy();
  });
});
