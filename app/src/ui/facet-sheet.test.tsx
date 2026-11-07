import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchFilters } from '../search/search-client';
import { FacetSheet } from './facet-sheet';

const counts = {
  rights: { redistributable: 1, link_only: 0 },
  grade: { LOW: 1 },
  trigger: { webhook: 1 },
  complexity: { simple: 1 },
  capabilities: {},
  integrations: {},
  tags: {},
};
const applied: SearchFilters = {
  trigger: ['webhook'],
  capability: [],
  complexity: '',
  grade: '',
  rights: '',
  integration: [],
  tag: [],
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FacetSheet', () => {
  it('does not mount the dialog or hidden facet options while closed', () => {
    const largeIntegrations = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`integration-${index}`, index + 1]),
    );

    render(
      <FacetSheet
        open={false}
        counts={{ ...counts, integrations: largeIntegrations }}
        filters={{ ...applied, integration: ['integration-99'] }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('#facet-search-integration')).toBeNull();
    expect(document.querySelector('#facet-search-tag')).toBeNull();
  });

  it('moves focus to the Close control when opened', () => {
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('returns focus to the opener when closed', () => {
    const { rerender } = render(
      <>
        <button type="button">Open filters</button>
        <FacetSheet open={false} counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open filters' });
    opener.focus();

    rerender(
      <>
        <button type="button">Open filters</button>
        <FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(document.activeElement).toBe(opener);
  });

  it('exposes the open filter sheet as a modal dialog', () => {
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Filters' }).getAttribute('aria-modal')).toBe('true');
  });

  it('keeps keyboard focus inside the open dialog', () => {
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    last?.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first?.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes when the dialog backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByRole('dialog', { name: 'Filters' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('locks body scrolling while open and restores it after closing', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    expect(document.body.style.overflow).toBe('hidden');
    rerender(<FacetSheet open={false} counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('auto');
  });

  it('uses sheet positioning on mobile and popover positioning on desktop', () => {
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('md:left-1/2');
    expect(dialog.className).toContain('md:top-20');
    expect(dialog.className).toContain('md:rounded-panel');
  });

  it('gives the sheet close control an accessible target and interaction states', () => {
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={() => {}} />);

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('h-11');
    expect(close.className).toContain('min-w-11');
    expect(close.className).toContain('focus-visible:ring-2');
    expect(close.className).toContain('active:bg-raised');
  });

  it('keeps applied filters unchanged while drafts reset on reopen', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<FacetSheet open counts={counts} filters={applied} onApply={onApply} onClose={onClose} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[1]!);
    expect(onApply).not.toHaveBeenCalled();
    expect(applied.trigger).toEqual(['webhook']);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<FacetSheet open={false} counts={counts} filters={applied} onApply={onApply} onClose={onClose} />);
    rerender(<FacetSheet open counts={counts} filters={applied} onApply={onApply} onClose={onClose} />);

    const webhookButtons = screen.getAllByRole('button', { name: /Webhook 1/ });
    expect(webhookButtons.at(-1)?.getAttribute('aria-pressed')).toBe('true');
  });

  it('applies staged selections only when Apply filters is chosen', () => {
    const onApply = vi.fn();
    render(<FacetSheet open counts={counts} filters={applied} onApply={onApply} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Redistributable 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(onApply).toHaveBeenCalledWith({ ...applied, rights: 'redistributable' });
  });

  it('cancels staged selections when the dialog is closed', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<FacetSheet open counts={counts} filters={applied} onApply={onApply} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Redistributable 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('notifies the parent exactly once when the user closes the sheet', () => {
    const onClose = vi.fn();
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    render(<FacetSheet open counts={counts} filters={applied} onApply={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
