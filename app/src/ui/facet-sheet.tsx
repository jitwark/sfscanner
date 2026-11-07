'use client';

import { useEffect, useRef, useState } from 'react';
import type { FacetCounts, SearchFilters } from '../search/search-client';
import { FacetRail } from './facet-rail';

type FacetSheetProps = {
  open: boolean;
  counts?: FacetCounts;
  filters: SearchFilters;
  onApply: (filters: SearchFilters) => void;
  onClose: () => void;
};

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )];
}

export function FacetSheet(props: FacetSheetProps) {
  if (!props.open) return null;
  return <FacetSheetContent key={props.open ? 'open' : 'closed'} {...props} />;
}

function FacetSheetContent({
  open,
  counts,
  filters,
  onApply,
  onClose,
}: FacetSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const didNotifyClose = useRef(false);
  const [draft, setDraft] = useState<SearchFilters>(filters);

  const restoreFocus = () => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected && !opener.hasAttribute('disabled')) opener.focus();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      didNotifyClose.current = false;
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      closeButtonRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  const notifyClose = () => {
    if (didNotifyClose.current) return;
    didNotifyClose.current = true;
    restoreFocus();
    onClose();
  };
  const close = () => {
    dialogRef.current?.close();
    notifyClose();
  };

  const apply = () => {
    onApply(draft);
    close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="mobile-filters-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={notifyClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = focusableElements(event.currentTarget);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      className="fixed inset-x-0 bottom-0 m-0 max-h-[85vh] w-full max-w-none rounded-t-panel bg-page p-0 text-ink shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)] backdrop:bg-black/60 open:animate-none md:inset-x-auto md:bottom-auto md:left-1/2 md:top-20 md:w-[min(32rem,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-panel md:border md:border-hairline md:max-w-xl"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 id="mobile-filters-title" className="font-display text-lg font-semibold">
            Filters
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            className="h-11 min-w-11 rounded-control px-3 text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised"
          >
            Close
          </button>
        </header>
        <div className="overflow-y-auto px-4 py-4">
          <FacetRail counts={counts} filters={draft} onFilterChange={setDraft} className="w-full" />
        </div>
        <footer className="flex gap-2 border-t border-hairline bg-page px-4 py-3">
          <button
            type="button"
            onClick={() => setDraft({ trigger: [], capability: [], complexity: '', grade: '', rights: '', integration: [], tag: [] })}
            className="h-11 flex-1 rounded-control border border-hairline px-3 text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={apply}
            className="h-11 flex-1 rounded-control bg-accent px-3 text-sm font-semibold text-page transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border focus-visible:ring-offset-2 focus-visible:ring-offset-page active:bg-accent/80"
          >
            Apply filters
          </button>
        </footer>
      </div>
    </dialog>
  );
}
