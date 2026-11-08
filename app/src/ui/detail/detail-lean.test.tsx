import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Entry, PublicFinding, SvgPreviewArtifact } from '@hub/contracts';
import { makeEntry } from '../../test-support/make-entry';
import { DetailLean } from './detail-lean';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const finding = (severity: PublicFinding['severity'], index: number): PublicFinding => ({
  id: `POLICY_${index}`,
  title: `Finding ${index} title`,
  severity,
  why: 'A long explanation of why this matters, repeated to take up realistic room in the markup.',
  fix: 'A long explanation of the remediation, repeated to take up realistic room in the markup.',
  node: `Node ${index}`,
});

function heavyEntry(): Entry {
  return makeEntry({
    id: 'heavy-1',
    slug: 'heavy-workflow-1',
    title: 'Sync Notion pages into Slack with an AI summary step',
    summary: 'A long-ish summary sentence describing what the workflow does end to end.',
    structure: {
      nodeCount: 24,
      connectionCount: 31,
      nodeTypes: ['n8n-nodes-base.slack'],
      integrations: ['slack', 'notion', 'openai', 'gmail'],
      trigger: 'webhook',
      complexity: 'complex',
      hasCode: true,
      hasAI: true,
      hasWebhook: true,
    },
    security: {
      grade: 'HIGH',
      score: 62,
      findings: Array.from({ length: 20 }, (_, i) => finding(i < 4 ? 'CRITICAL' : 'MEDIUM', i)),
      counts: { critical: 4, high: 0, medium: 16, low: 0, info: 0 },
    },
  });
}

const related = [
  { id: 'r1', slug: 'related-one', title: 'Related workflow one' },
  { id: 'r2', slug: 'related-two', title: 'Related workflow two' },
];

const preview: SvgPreviewArtifact = {
  schemaVersion: 'svg-preview-v1',
  tier: 'A',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><title>Workflow diagram</title></svg>',
  nodeList: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' }],
  contentHash: 'a'.repeat(64),
  unresolvedEdgeCount: 0,
};

describe('DetailLean content and Workbench structure', () => {
  it('carries crawler facts and renders Studio Header', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} />);
    expect(within(container).getByRole('heading', { level: 1 }).textContent).toContain('Sync Notion');
    expect(container.textContent).toContain(heavyEntry().summary);
    expect(container.querySelector(`a[href="${heavyEntry().source.permalink}"]`)).not.toBeNull();
    expect(container.textContent).toContain('Finding 0 title');
  });

  it('renders vector diagram and canvas viewport when preview is provided', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} preview={preview} />);
    expect(container.querySelector('[data-canvas-viewport]')).not.toBeNull();
    expect(container.querySelector('[data-compact-vector-diagram]')).not.toBeNull();
  });

  it('renders the direct download workflow button for redistributable entries', () => {
    const entry = makeEntry({ rights: { status: 'redistributable' } });
    const { container } = render(<DetailLean entry={entry} related={[]} />);
    const downloadBtn = within(container).getByRole('button', { name: /download workflow/i });
    expect(downloadBtn).toBeTruthy();
    expect(downloadBtn.getAttribute('data-download-pack')).toBeDefined();
  });

  it.each([
    ['GitHub link-only', makeEntry({ rights: { status: 'link_only' } }), 'View on GitHub'],
    ['official link-only', makeEntry({ source: { kind: 'n8n_official', permalink: 'https://n8n.io/workflows/42' }, rights: { status: 'link_only' } }), 'View on n8n.io'],
  ] as const)('uses the honest %s action link when not directly redistributable', (_label, entry, action) => {
    const view = within(render(<DetailLean entry={entry} related={[]} />).container);
    expect(view.getByRole('link', { name: action })).toBeTruthy();
    expect(view.queryByRole('button', { name: /download workflow/i })).toBeNull();
  });

  it('offers no Expand diagram control, which needs React state this tier never runs', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} preview={preview} />);
    const view = within(container);

    expect(view.queryByRole('button', { name: 'Expand diagram' })).toBeNull();
    expect(view.getByRole('button', { name: 'Download vector SVG' }), 'the controls the static script does own stay').toBeTruthy();
  });

  it('stays inside the 65 KB static-page budget for heavy entries', () => {
    const markup = renderToStaticMarkup(<DetailLean entry={heavyEntry()} related={related} preview={preview} />);
    expect(Buffer.byteLength(markup, 'utf8')).toBeLessThan(65_000);
  });
});

describe('DetailLean hierarchy and section anchors', () => {
  it('keeps the current detail breadcrumb a label when the slug needs encoding', () => {
    const entry = makeEntry({ slug: 'folder/name?one' });
    const { container } = render(<DetailLean entry={entry} related={[]} />);

    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(entry.title);
    expect(container.querySelector('a[href^="/w/folder/"]')).toBeNull();
  });

  it('contains all canonical workbench section anchors', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} />);
    for (const id of ['before-you-run', 'workflow-canvas', 'security', 'about', 'provenance']) {
      const anchor = container.querySelector(`#${id}`);
      expect(anchor, id).not.toBeNull();
    }
  });

  it('keeps the interactive handoff on the canvas, not in the security summary', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} />);

    expect(container.querySelector('#security a[href*="/w/view/"]')).toBeNull();
    expect(container.querySelector('#workflow-canvas a[href*="/w/view/"]')).not.toBeNull();
  });

  it.each(['', '/', '///', '/sfscanner'])(
    'never emits a protocol-relative interactive href for base path %j',
    (basePath) => {
      vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
      const { container } = render(<DetailLean entry={heavyEntry()} related={related} />);
      const link = container.querySelector<HTMLAnchorElement>('#workflow-canvas a[href*="/w/view/"]');

      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')?.startsWith('//')).toBe(false);
      expect(link!.getAttribute('href')).toBe(
        basePath === '/sfscanner'
          ? '/sfscanner/w/view/?id=heavy-1&related=r1,r2'
          : '/w/view/?id=heavy-1&related=r1,r2',
      );
    },
  );

  it('emits every id at most once, so anchors and aria-labelledby targets stay unambiguous', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={related} preview={preview} />);
    const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);

    expect(ids.filter((id, index) => ids.indexOf(id) !== index), 'ids emitted twice in one lean document').toEqual([]);
  });

  it('discloses readiness details under before-you-run', () => {
    const { container } = render(<DetailLean entry={heavyEntry()} related={[]} />);
    const section = container.querySelector('#before-you-run');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Before you run');
  });

  it('preserves the grade accurately', () => {
    const container = render(<DetailLean entry={makeEntry({ security: { grade: 'LOW' } })} related={[]} />).container;
    expect(within(container).getByLabelText('Scanner grade LOW, score 100 out of 100')).toBeTruthy();
  });

  it('shows the persisted analysis status without inferring Standard scan', () => {
    const base = makeEntry();
    const entry = { ...base, security: { ...base.security, analysisStatus: 'DEGRADED' as const } };
    const container = render(<DetailLean entry={entry} related={[]} />).container;
    const security = container.querySelector<HTMLElement>('#security');

    expect(security).not.toBeNull();
    expect(within(security!).getByText('Partial analysis')).toBeTruthy();
    expect(within(container).queryAllByText('Standard scan')).toHaveLength(0);
  });

  it('handles description provenance honestly', () => {
    const { container } = render(<DetailLean entry={makeEntry({ descriptionSource: 'upstream', description: 'Authoritative copy.' })} related={[]} />);
    expect(within(container).getByLabelText('Upstream description')).toBeTruthy();
    expect(container.textContent).toContain('Authoritative copy.');
  });
});

/**
 * FE-05 on the surface that missed it. A lean page is one static HTML file and
 * nothing on it ever updates, so neither branch of the pre-run notice may claim
 * live-region semantics: a live region announces changes, and these sentences
 * never change. `detail-lean.tsx` records the evidence, including why the
 * `alert` branch loses its role as well. The visible copy is pinned here because
 * the fix must not touch it.
 */
describe('DetailLean pre-run notice is static text, not a live region', () => {
  const emptyReadiness = {
    credentials: [],
    replaceableValues: [],
    writeActions: [],
    aiModel: { present: false, model: null },
    extraPackages: [],
    versionNotes: [],
    pinnedData: { present: false, nodeCount: 0 },
    isSubWorkflow: false,
  };
  // Every role carrying an implicit live region, per MDN's live-region role table.
  const LIVE_REGIONS = '[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [role="progressbar"]';

  function noticeSection(container: HTMLElement): HTMLElement {
    const section = container.querySelector<HTMLElement>('#before-you-run');
    expect(section, '#before-you-run').not.toBeNull();
    return section!;
  }

  it('renders the published-readiness copy with no live region around it', () => {
    const { container } = render(<DetailLean entry={{ ...heavyEntry(), readiness: emptyReadiness } as Entry} related={[]} />);
    const section = noticeSection(container);

    expect(section.textContent).toContain('Detailed deterministic pre-run checks are available in the interactive view. Review them before importing.');
    expect(section.querySelectorAll(LIVE_REGIONS)).toHaveLength(0);
  });

  it('renders the not-ready warning with no live region around it either', () => {
    const { container } = render(<DetailLean entry={makeEntry({ structure: { partial: true } })} related={[]} />);
    const section = noticeSection(container);

    expect(section.textContent).toContain('Workflow body is unavailable. This metadata-only entry has only partial structure data; do not treat it as ready to run. Review the upstream workflow before importing.');
    expect(section.querySelectorAll(LIVE_REGIONS)).toHaveLength(0);
  });

  it('renders the unscanned disclaimer when no workflow JSON was available', () => {
    const entry: Entry = {
      ...makeEntry({ structure: { partial: true } }),
      readiness: { ...emptyReadiness, analysis: 'unscanned' },
    };
    const { container } = render(<DetailLean entry={entry} related={[]} />);
    const section = noticeSection(container);

    expect(section.textContent).toContain('No workflow JSON was available for analysis');
    expect(section.textContent).toContain('unknown, not confirmed absent');
    expect(section.textContent).toContain('partial structure data');
    expect(section.querySelectorAll(LIVE_REGIONS)).toHaveLength(0);
  });
});
