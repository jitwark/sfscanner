'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme/theme-toggle';
import { productRepositoryUrl } from './product-links';

type NavItem = { href: '/library/' | '/scanner/' | '/analytics/' | '/about/'; label: string };

const NAV: NavItem[] = [
  { href: '/library/', label: 'Library' },
  { href: '/scanner/', label: 'Scanner' },
  { href: '/analytics/', label: 'Analytics' },
  { href: '/about/', label: 'About' },
];

export type SiteHeaderProps = {
  /** Workflows a visitor can actually reach — not the raw corpus count. */
  searchableCount: number;
};

export function SiteHeader({ searchableCount }: SiteHeaderProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const pathname = usePathname();
  const isOpen = pathname !== null && openPath === pathname;
  // One read for both lists. With no configured repository the entry is
  // omitted entirely: the site does not advertise a link nobody can open.
  const repositoryUrl = productRepositoryUrl();


  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-page/90 backdrop-blur-md text-ink">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-3 sm:px-6">
        {/* Brand logo & workflow count badge */}
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            prefetch={false}
            className="group flex min-h-11 items-center gap-2.5 rounded-control focus-visible:outline-2 focus-visible:outline-accent-border"
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 bg-accent transition-transform duration-120 group-hover:scale-110"
            />
            <span className="font-sans text-lg font-bold tracking-tight text-ink">
              n8n<span className="text-accent-text">-</span>secureflow
            </span>
          </Link>
          <span className="hidden items-center gap-1.5 rounded-control border border-hairline bg-raised px-2.5 py-0.5 font-mono text-2xs tabular-nums text-ink-muted sm:inline-flex">
            <span className="text-ink font-bold">{searchableCount.toLocaleString('en-US')}</span>
            <span>workflows</span>
          </span>
        </div>

        {/* Desktop navigation bar (>= 1024px) */}
        <div className="hidden lg:flex min-w-0 items-center gap-3">
          <nav aria-label="Main">
            <ul className="flex items-center gap-1 sm:gap-2">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    className="flex min-h-11 items-center rounded-control px-2.5 text-sm font-bold text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-border sm:px-3.5"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              {repositoryUrl ? (
                <li>
                  <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-sm font-bold text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-border sm:px-3.5"
                  >
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                    <span>GitHub</span>
                  </a>
                </li>
              ) : null}
            </ul>
          </nav>

          <Link
            href="/scanner/"
            prefetch={false}
            className="inline-flex items-center justify-center rounded-control bg-accent px-4 py-1.5 text-xs font-bold text-accent-ink transition-colors hover:brightness-95 active:brightness-90"
          >
            Scan Workflow
          </Link>

          <ThemeToggle />
        </div>

        {/* Mobile controls (< 1024px): Theme toggle + Hamburger menu button */}
        <div className="flex lg:hidden items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            aria-label={isOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isOpen}
            onClick={() => setOpenPath(isOpen ? null : pathname)}
            className="flex h-11 w-11 items-center justify-center rounded-control border border-hairline bg-panel text-ink transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent-border"
          >
            {isOpen ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile drawer panel */}
      {isOpen && (
        <nav aria-label="Mobile Navigation" className="border-t border-hairline bg-panel px-4 py-3 lg:hidden shadow-lg animate-in fade-in duration-150">
          <ul className="flex flex-col gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  prefetch={false}
                  onClick={() => setOpenPath(null)}
                  className="flex min-h-11 items-center rounded-control px-3 text-sm font-bold text-ink hover:bg-raised active:bg-raised"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            {repositoryUrl ? (
              <li>
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpenPath(null)}
                  className="flex min-h-11 items-center gap-2 rounded-control px-3 text-sm font-bold text-ink hover:bg-raised active:bg-raised"
                >
                  <svg className="h-4 w-4 fill-current" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  <span>GitHub</span>
                </a>
              </li>
            ) : null}
            <li className="pt-2 border-t border-hairline mt-1">
              <Link
                href="/scanner/"
                prefetch={false}
                onClick={() => setOpenPath(null)}
                className="flex min-h-11 items-center justify-center rounded-control bg-accent px-4 text-xs font-bold text-accent-ink transition-colors hover:brightness-95 active:brightness-90"
              >
                Scan Workflow
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
