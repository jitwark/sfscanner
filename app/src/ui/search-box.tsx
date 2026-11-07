'use client';

import { useRef, useEffect } from 'react';
import type { KeyboardEvent, ChangeEvent } from 'react';
import { sitePath } from './site-url.mjs';

export type SearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (query: string) => void;
  onNavigateHighlight?: (direction: 'up' | 'down') => void;
  onSelectHighlight?: () => void;
  onFocus?: () => void;
  resultCount?: number;
  resultsRendered?: boolean;
  activeIndex?: number;
  activeDescendantId?: string;
  isHomepage?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
};
export function SearchBox({
  value,
  onChange,
  onSubmit,
  onNavigateHighlight,
  onSelectHighlight,
  onFocus,
  resultCount = 0,
  resultsRendered,
  activeIndex = -1,
  activeDescendantId,
  isHomepage = false,
  placeholder = 'Send Slack message when Stripe payment fails...',
  autoFocus = false,
  ariaLabel = 'Search n8n workflows',
}: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/') return;
      const activeEl = document.activeElement;
      const isInputEl =
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          (activeEl as HTMLElement).isContentEditable);

      if (!isInputEl) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (value.trim().length > 0) {
        onChange('');
      } else {
        inputRef.current?.blur();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onNavigateHighlight?.('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onNavigateHighlight?.('up');
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && onSelectHighlight) {
        e.preventDefault();
        onSelectHighlight();
      } else if (onSubmit) {
        e.preventDefault();
        onSubmit(value);
      }
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleClear = () => {
    onChange('');
    inputRef.current?.focus();
  };

  const isExpanded = resultsRendered ?? resultCount > 0;

  return (
    <form
      action={sitePath('/library/')}
      method="get"
      role="search"
      className="relative w-full"
      onSubmit={(e) => {
        if (!isHomepage && onSubmit) {
          e.preventDefault();
          onSubmit(value);
        }
      }}
    >
      <div className="relative flex items-center w-full h-[44px] bg-panel border border-hairline rounded-input focus-within:border-accent-border focus-within:outline-2 focus-within:outline-accent-border focus-within:outline-offset-2">
        <svg
          className="absolute left-3.5 w-4 h-4 text-ink-faint pointer-events-none"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>

        <input
          ref={inputRef}
          onFocus={onFocus}
          type="text"
          name="q"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? 'search-results-list' : undefined}
          aria-activedescendant={isExpanded ? activeDescendantId : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          className="w-full h-full pl-10 pr-16 bg-transparent text-ink text-base placeholder:text-ink-faint focus:outline-none"
        />

        <div className="absolute right-3 flex items-center space-x-2">
          {value ? (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink focus-visible:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border active:bg-raised active:text-accent-text"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <kbd className="hidden sm:inline-flex items-center justify-center h-5 px-1.5 font-mono text-[11px] text-ink-faint bg-raised border border-hairline rounded-control">
              /
            </kbd>
          )}
        </div>
      </div>
    </form>
  );
}
