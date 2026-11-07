import Link from 'next/link';
import { CornerSquare } from './primitives/corner-square';

type Tool = {
  href: '/library/' | '/scanner/';
  eyebrow: string;
  title: string;
  body: string;
  action: string;
};

const TOOLS: Tool[] = [
  {
    href: '/library/',
    eyebrow: 'Find',
    title: 'Browse the catalogue',
    body: 'Filter by integration, trigger, complexity and security grade. Every entry links back to a recorded permalink at its source.',
    action: 'Open the library',
  },
  {
    href: '/scanner/',
    eyebrow: 'Check',
    title: 'Scan a workflow you already have',
    body: 'Paste or drop a workflow JSON and get deterministic findings — the same rules that graded everything in the catalogue.',
    action: 'Open the scanner',
  },
];

/**
 * Interactive tools chapter for the homepage.
 * Adheres to the engineering design specification: 32px padding, 2px radius, and signature corner squares.
 */
export function HomeTools() {
  return (
    <section aria-label="What you can do here" className="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2">
      {TOOLS.map((tool) => (
        <Link
          key={tool.href}
          href={tool.href}
          prefetch={false}
          className="group relative flex min-h-11 min-w-0 flex-col gap-3 rounded-panel border border-hairline bg-panel p-6 lg:p-8 transition-colors hover:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-border"
        >
          <CornerSquare position="top-left" size="md" />
          <span className="font-mono text-2xs uppercase tracking-wider text-ink-muted pl-2">
            {tool.eyebrow}
          </span>
          <span className="font-sans text-xl font-bold tracking-tight text-ink group-hover:text-accent-text">
            {tool.title}
          </span>
          <span className="text-sm leading-6 text-ink-muted">{tool.body}</span>
          <span className="mt-auto pt-3 font-mono text-xs font-bold text-accent-text flex items-center gap-1.5">
            {tool.action}
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
              →
            </span>
          </span>
        </Link>
      ))}
    </section>
  );
}
