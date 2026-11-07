import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FacetRail } from './facet-rail';

describe('FacetRail', () => {
  afterEach(() => {
    cleanup();
  });

  const sampleCounts = {
    rights: { redistributable: 1900, link_only: 300 },
    grade: { LOW: 1900, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 300 },
    trigger: { webhook: 300, schedule: 450, manual: 0 },
    complexity: { simple: 400, medium: 800, complex: 900 },
    tags: { email: 350, openai: 180, postgres: 0 },
    capabilities: { code: 0, ai: 42, webhook: 0 },
    integrations: { openai: 180 },
  };

  it('renders filter titles and counts', () => {
    render(<FacetRail counts={sampleCounts} filters={{}} onFilterChange={() => {}} />);

    expect(screen.getByText('Filters')).toBeDefined();
    expect(screen.getByText('Redistributable')).toBeDefined();
    expect(screen.getAllByText('1900')).toHaveLength(2);
    expect(screen.getAllByText('Webhook')).toHaveLength(2);
    expect(screen.getAllByText('300').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /LOW 1900/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Link-only 300/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /AI 42/ })).toBeDefined();
  });

  it('disables items with count === 0', () => {
    render(<FacetRail counts={sampleCounts} filters={{}} onFilterChange={() => {}} />);

    const manualBtn = screen.getByRole('button', { name: /Manual 0/ });
    expect(manualBtn.hasAttribute('disabled')).toBe(true);
  });

  it('keeps a selected zero-count facet enabled so it can be removed', () => {
    const onFilterChange = vi.fn();
    render(<FacetRail counts={sampleCounts} filters={{ trigger: ['manual'] }} onFilterChange={onFilterChange} />);

    const manualBtn = screen.getByRole('button', { name: /Manual 0/ });
    expect(manualBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(manualBtn);

    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ trigger: [] }));
  });

  it('gives facet buttons and the filter input accessible targets and visible states', () => {
    render(<FacetRail counts={sampleCounts} filters={{ trigger: ['webhook'] }} onFilterChange={() => {}} />);

    const selected = screen.getByRole('button', { name: /Webhook 300/ });
    expect(selected.className).toContain('min-h-11');
    expect(selected.className).toContain('focus-visible:ring-2');
    expect(selected.className).toContain('active:bg-raised');
    expect(selected.className).toContain('ring-1');

    const input = screen.getByRole('textbox', { name: 'Filter integrations' });
    expect(input.className).toContain('h-11');
    expect(input.className).toContain('hover:border-ink-muted');
    expect(input.className).toContain('focus-visible:ring-2');
  });

  it('provides an independent search input for each discovery group', () => {
    render(<FacetRail counts={sampleCounts} filters={{}} onFilterChange={() => {}} />);

    expect(screen.getByRole('textbox', { name: 'Filter integrations' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Filter tags' })).toBeDefined();
  });

  it('invokes onFilterChange when a filter button is clicked', () => {
    const onFilterChange = vi.fn();
    render(<FacetRail counts={sampleCounts} filters={{}} onFilterChange={onFilterChange} />);

    const webhookBtn = screen.getByRole('button', { name: /Webhook 300/ });
    fireEvent.click(webhookBtn);

    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ trigger: ['webhook'] }));
  });

  it('searches canonical integration and tag labels without hiding selected zero-count values', () => {
    render(<FacetRail counts={sampleCounts} filters={{ tag: ['custom-tag'] }} onFilterChange={() => {}} />);
    const integrationInput = screen.getByRole('textbox', { name: 'Filter integrations' });
    const tagInput = screen.getByRole('textbox', { name: 'Filter tags' });
    fireEvent.change(integrationInput, { target: { value: 'openai' } });
    expect((tagInput as HTMLInputElement).value).toBe('');
    fireEvent.change(tagInput, { target: { value: 'custom tag' } });

    expect(screen.getByRole('button', { name: /Custom Tag 0/ })).toBeDefined();
  });

  it('keeps a selected discovery value visible when its search term does not match', () => {
    render(<FacetRail counts={sampleCounts} filters={{ tag: ['custom-tag'] }} onFilterChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter tags' }), { target: { value: 'does-not-match' } });

    expect(screen.getByRole('button', { name: /Custom Tag 0/ })).toBeDefined();
  });

  it('keeps near-duplicate labels independently selectable by their canonical slug', () => {
    const onFilterChange = vi.fn();
    render(<FacetRail counts={{ ...sampleCounts, tags: { 'daily-digest': 5, 'daily-digests': 5 } }} filters={{}} onFilterChange={onFilterChange} />);

    const singular = screen.getByRole('button', { name: 'Daily Digest 5' });
    const plural = screen.getByRole('button', { name: 'Daily Digests 5' });
    expect(singular).not.toBe(plural);

    fireEvent.click(singular);
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ tag: ['daily-digest'] }));
    fireEvent.click(plural);
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ tag: ['daily-digests'] }));
  });

  it('wraps long discovery labels instead of clipping their visible text', () => {
    const longTag = 'a-really-long-community-workflow-classification-label';
    render(<FacetRail counts={{ ...sampleCounts, tags: { [longTag]: 1 } }} filters={{}} onFilterChange={() => {}} />);

    const button = screen.getByRole('button', { name: /A Really Long Community Workflow/ });
    const text = button.querySelector('span');
    expect(text?.className).toContain('whitespace-normal');
    expect(text?.className).toContain('break-words');
  });

  it('announces when a discovery group has no matches', () => {
    render(<FacetRail counts={sampleCounts} filters={{}} onFilterChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter tags' }), { target: { value: 'does-not-match' } });

    expect(screen.getByText('No matching tags.')).toBeDefined();
  });

  it('renders every canonical tag instead of silently capping the catalogue', () => {
    const tags = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`tag-${index}`, index + 1]));
    render(<FacetRail counts={{ ...sampleCounts, tags }} filters={{}} onFilterChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'Tag 0 1' })).toBeDefined();
  });

  it('bounds discovery options and reveals more incrementally', () => {
    const tags = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`tag-${index}`, index + 1]));
    render(<FacetRail counts={{ ...sampleCounts, tags }} filters={{}} onFilterChange={() => {}} />);

    const tagButtons = () => screen.getAllByRole('button').filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('Tag '));
    expect(tagButtons()).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Show 60 more tags' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Show 60 more tags' }));

    expect(tagButtons()).toHaveLength(80);
    expect(screen.getByRole('button', { name: 'Show 20 more tags' })).toBeDefined();
  });

  it('keeps selected discovery values visible inside the bounded window', () => {
    const tags = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`tag-${index}`, index + 1]));
    render(<FacetRail counts={{ ...sampleCounts, tags }} filters={{ tag: ['tag-99'] }} onFilterChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'Tag 99 100' })).toBeDefined();
    expect(screen.getAllByRole('button').filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('Tag '))).toHaveLength(40);
  });

  it('bounds the largest integration facet, pins a selected value, and expands accessibly', () => {
    const integrations = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`integration-${index}`, index + 1]));
    render(<FacetRail counts={{ ...sampleCounts, integrations }} filters={{ integration: ['integration-99'] }} onFilterChange={() => {}} />);

    const integrationButtons = () => screen.getAllByRole('button').filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('Integration '));
    expect(integrationButtons()).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Integration 99 100' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show 60 more integrations' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Show 60 more integrations' }));

    expect(integrationButtons()).toHaveLength(80);
    expect(screen.getByRole('button', { name: 'Show 20 more integrations' })).toBeDefined();
  });

  it('clears all filters when Clear all is clicked', () => {
    const onFilterChange = vi.fn();
    render(
      <FacetRail
        counts={sampleCounts}
        filters={{ trigger: ['webhook'], rights: 'redistributable' }}
        onFilterChange={onFilterChange}
      />
    );

    const clearBtn = screen.getByText('Clear all');
    fireEvent.click(clearBtn);

    expect(onFilterChange).toHaveBeenCalledWith({
      trigger: [],
      capability: [],
      complexity: '',
      grade: '',
      rights: '',
      integration: [],
      tag: [],
    });
  });
});
