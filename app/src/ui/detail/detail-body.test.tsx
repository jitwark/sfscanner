import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry, GeneratedDescription } from '@hub/contracts';
import { DetailBody } from './detail-body';

// This project does not enable Vitest globals, so Testing Library's automatic
// per-test cleanup never registers and renders accumulate in one document.
afterEach(() => cleanup());

function entry(rights: 'redistributable' | 'link_only'): Entry {
  return {
    id: 'abc123',
    slug: 'mail-workflow',
    title: 'Mail workflow',
    summary: 'Sends mail safely.',
    description: 'Sends mail safely. https://description.example.invalid must not become provenance.',
    descriptionSource: 'upstream',
    source: {
      kind: rights === 'link_only' ? 'n8n_official' : 'github',
      repo: 'owner/repo',
      commit: 'abcdef0123456',
      permalink: 'https://github.com/owner/repo/blob/abcdef0/workflow.json',
      author: { name: 'A. Author' },
      stars: 42,
      fetchedAt: '2026-08-13T00:00:00.000Z',
    },
    rights: {
      status: rights,
      licence: rights === 'redistributable' ? 'MIT' : null,
      licenceUrl: rights === 'redistributable' ? 'https://spdx.org/licenses/MIT.html' : null,
      reason: rights === 'redistributable' ? 'Repository licence: MIT' : 'Hosted upstream',
    },
    structure: {
      nodeCount: 4,
      rawNodeCount: 4,
      annotationNodeCount: 0,
      connectionCount: 3,
      nodeTypes: ['manualTrigger'],
      integrations: ['Gmail'],
      trigger: 'Manual',
      isSubWorkflow: false,
      complexity: 'simple',
      hasCode: false,
      hasAI: false,
      hasWebhook: false,
    },
    security: {
      grade: 'LOW',
      score: 99,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
      findings: [{ id: 'f1', title: 'Informational check', severity: 'INFO', why: 'Why', fix: 'Fix' }],
      hardenedExtra: 0,
      scannerVersion: 'beta-1',
      profile: 'beta-default',
    },
    tags: ['mail'],
    dedup: { fingerprint: 'fp', structuralHash: 'sh', canonical: true, alsoFoundIn: [] },
  };
}

const descriptionContent: GeneratedDescription = {
  headline: 'A publishable workflow explanation',
  summary: 'This explanation is safe to publish.',
  outcome: 'An input is processed.',
  beforeAfter: { before: 'Manual work.', after: 'Automated work.' },
  exampleScenario: 'A reader processes an input.',
  howItWorks: ['Accept an input.'],
  limitations: ['Review configuration before use.'],
  audience: 'Workflow builders.',
};

describe('DetailBody', () => {
  it('keeps findings in the HTML and omits download controls for link-only entries', () => {
    render(<DetailBody entry={entry('link_only')} related={[]} />);
    expect(screen.getByText('Informational check')).toBeTruthy();
    expect(screen.getAllByText(/Hosted upstream/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
    expect(document.body.textContent).toContain('https://description.example.invalid');
    expect(screen.getAllByRole('link', { name: 'n8n.io' })[0]?.getAttribute('href')).toBe('https://github.com/owner/repo/blob/abcdef0/workflow.json');
  });

  it('does not render deterministic fallback prose', () => {
    render(<DetailBody entry={{ ...entry('link_only'), descriptionSource: 'fallback', descriptionProvenance: { source: 'fallback' }, descriptionContent, description: 'Fallback prose must never ship.' }} related={[]} />);
    expect(screen.queryByText('Fallback prose must never ship.')).toBeNull();
    expect(screen.queryByText(descriptionContent.headline)).toBeNull();
    expect(screen.getByLabelText('Fallback description')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Gemini/i);
    expect(screen.getByText(/publishable description is not available/i)).toBeTruthy();
  });

  it('publishes structured generated content only with explicit generated provenance', () => {
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), descriptionSource: 'generated', descriptionProvenance: { source: 'gemini', model: 'explicit-model' }, descriptionContent }} related={[]} />);
    const view = within(container);
    expect(view.getByText(descriptionContent.headline)).toBeTruthy();
    expect(view.getByLabelText('AI-generated description')).toBeTruthy();
  });

  it('rejects structured content for upstream entries and renders only the upstream description', () => {
    const upstreamDescription = 'Authoritative plain upstream description.';
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), description: upstreamDescription, descriptionSource: 'upstream', descriptionProvenance: { source: 'upstream' }, descriptionContent }} related={[]} />);
    const view = within(container);
    expect(view.queryByText(descriptionContent.headline)).toBeNull();
    expect(view.getByText(upstreamDescription)).toBeTruthy();
    expect(view.getByLabelText('Upstream description')).toBeTruthy();
  });

  it('renders plain upstream descriptions with a generic label when optional provenance is absent', () => {
    const upstreamDescription = 'Legacy upstream description without optional provenance.';
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), description: upstreamDescription, descriptionSource: 'upstream', descriptionProvenance: undefined }} related={[]} />);
    const view = within(container);
    expect(view.getByText(upstreamDescription)).toBeTruthy();
    expect(view.getByLabelText('Upstream description')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Gemini/i);
  });

  it('does not publish generated content when provenance is missing', () => {
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), descriptionSource: 'generated', descriptionContent }} related={[]} />);
    const view = within(container);
    expect(view.queryByText(descriptionContent.headline)).toBeNull();
    expect(view.getByLabelText('Description provenance unknown')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Gemini/i);
  });

  it('does not publish content with unknown provenance', () => {
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), descriptionSource: 'generated', descriptionProvenance: { source: 'unknown' }, descriptionContent }} related={[]} />);
    const view = within(container);
    expect(view.queryByText(descriptionContent.headline)).toBeNull();
    expect(view.getByLabelText('Description provenance unknown')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Gemini/i);
  });

  it.each([
    { rights: 'redistributable' as const, actionRole: 'button' as const, actionName: 'Download workflow' },
    { rights: 'link_only' as const, actionRole: 'link' as const, actionName: 'View on n8n.io' },
  ])('renders the target information hierarchy for $rights entries with one page heading', ({ rights, actionRole, actionName }) => {
    const inspectedEntry: Entry = {
      ...entry(rights),
      security: {
        ...entry(rights).security,
        grade: 'HIGH',
        score: 62,
        counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        findings: [{ id: 'f2', title: 'Review outbound request', severity: 'HIGH', why: 'It writes externally.', fix: 'Confirm the destination.' }],
      },
      readiness: {
        credentials: ['Gmail'],
        replaceableValues: [],
        writeActions: ['sends email messages'],
        aiModel: { present: false, model: null },
        extraPackages: [],
        versionNotes: [],
        pinnedData: { present: false, nodeCount: 0 },
        isSubWorkflow: false,
      },
    };

    const { container } = render(<DetailBody entry={inspectedEntry} related={[]} />);
    const view = within(container);
    const markers = [
      view.getByRole('heading', { level: 1, name: 'Mail workflow' }),
      view.getByText('Sends mail safely.', { selector: 'p' }),
      view.getByRole(actionRole, { name: actionName }),
      view.getByLabelText('Workflow metrics'),
      view.getByRole('heading', { name: 'Before you run' }),
      view.getByRole('heading', { name: 'Workflow canvas' }),
      view.getByRole('heading', { name: 'Security summary' }),
      view.getByRole('heading', { name: 'About this workflow' }),
      view.getByRole('heading', { name: 'Provenance' }),
      view.getByRole('heading', { name: 'Related workflows' }),
    ];
    markers.slice(0, -1).forEach((marker, index) => {
      expect(marker.compareDocumentPosition(markers[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getAllByRole('navigation', { name: 'Workflow sections' })).toHaveLength(1);
    const ids = ['before-you-run', 'workflow-canvas', 'security', 'about', 'provenance'];
    ids.forEach((id) => {
      const section = container.querySelector(`[id="${id}"]`);
      expect(section, id).not.toBeNull();
      expect(section?.className, id).toContain('scroll-mt-24');
    });
    expect(view.getByRole('link', { name: /Security/ }).getAttribute('href')).toBe('#security');
  });

  it('keeps the current breadcrumb readable and labels it for assistive technology', () => {
    const longTitle = 'A workflow title that must remain readable on a three hundred and twenty pixel screen';
    const { container } = render(<DetailBody entry={{ ...entry('link_only'), title: longTitle }} related={[]} />);
    const view = within(container);

    // Announced as "Current page: <title>" via sr-only text ahead of the
    // label, rather than an aria-label — which would have *replaced* the
    // visible title instead of prefixing it.
    const current = view.getByText(longTitle, { selector: '[aria-current="page"]' });
    expect(current.textContent).toBe(`Current page: ${longTitle}`);
    expect(current.className).not.toContain('truncate');
    expect(current.className).toContain('break-words');
    expect(view.getByRole('navigation', { name: 'Breadcrumbs' }).className).toContain('min-w-0');
  });
});

/**
 * WP-1 and WP-2 (audit 2026-08-25).
 *
 * The grid is `lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]` and children were
 * pinned to explicit cells. Nothing was placed in row 1 column 1, so on every
 * one of 13,221 desktop pages the WIDE column of row 1 rendered empty while
 * ReadinessSignals was squeezed into the 20rem one. Row 4 repeated it for the
 * 10.41% of entries whose `alsoFoundIn` is empty and `Duplicates` returns null.
 *
 * The active P5.2 runbook supersedes the older provenance-first note in
 * `docs/UI-WORKFLOW-PAGE.md`: source/provenance belongs after the usable detail
 * surfaces and before related content.
 */
describe('DetailBody layout', () => {
  it('keeps the static workbench tree for a layout=default URL until hydration', () => {
    window.history.replaceState({}, '', '/w/mail-workflow/?layout=default');

    const html = renderToString(<DetailBody entry={entry('redistributable')} related={[]} initialLayout="workbench" />);

    expect(html).toContain('data-layout="workbench"');
  });

  it('applies layout=default after the static workbench tree hydrates', async () => {
    window.history.replaceState({}, '', '/w/mail-workflow/?layout=default');
    render(<DetailBody entry={entry('redistributable')} related={[]} initialLayout="workbench" />);

    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Workflow sections' })).toBeTruthy());
  });

  it('restores the initial layout when history removes the URL override', async () => {
    window.history.replaceState({}, '', '/w/mail-workflow/?layout=default');
    render(<DetailBody entry={entry('redistributable')} related={[]} initialLayout="workbench" />);
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Workflow sections' })).toBeTruthy());

    window.history.replaceState({}, '', '/w/mail-workflow/');
    fireEvent.popState(window);

    await waitFor(() => expect(document.querySelector('[data-layout="workbench"]')).not.toBeNull());
  });

  it('pins no child to a grid cell, so nothing reserves a column it does not fill', () => {
    const { container } = render(<DetailBody entry={entry('redistributable')} related={[]} />);
    const pinned = Array.from(container.querySelectorAll('[class*="lg:col-start-"], [class*="lg:row-start-"]'));
    expect(pinned.map((element) => element.getAttribute('class'))).toEqual([]);
  });

  it('places provenance after the detail surfaces and before related content', () => {
    const { container } = render(<DetailBody entry={entry('redistributable')} related={[]} />);
    const provenance = container.querySelector('#provenance')!;
    const security = container.querySelector('#security')!;
    const about = container.querySelector('#about')!;
    const related = container.querySelector('#related-heading')!;
    expect(security.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(about.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(provenance.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists section anchors in rendered page order', () => {
    const { container } = render(<DetailBody entry={entry('redistributable')} related={[]} />);
    const railHrefs = Array.from(container.querySelectorAll('nav[aria-label="Workflow sections"] a'))
      .map((anchor) => anchor.getAttribute('href'));
    expect(railHrefs).toEqual(['#before-you-run', '#workflow-canvas', '#security', '#about', '#provenance']);
  });
});
