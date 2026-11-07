import { Breadcrumbs, type BreadcrumbItem } from './breadcrumbs';

export type { BreadcrumbItem };

export type HubHeaderProps = {
  title: string;
  count: number;
  introCopy: string;
  breadcrumbs: BreadcrumbItem[];
};

/**
 * This rendered its own breadcrumb trail rather than using `Breadcrumbs`, so
 * the two drifted: this one did not wrap, did not truncate, and kept the
 * sub-24px targets after the shared component was fixed. It now delegates.
 */
export function HubHeader({ title, count, introCopy, breadcrumbs }: HubHeaderProps) {
  return (
    <header className="mb-8 flex flex-col gap-3 border-b border-hairline pb-5">
      <Breadcrumbs items={breadcrumbs} className="rounded-control" />

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-balance font-sans text-3xl font-bold tracking-tight text-ink md:text-4xl">
          {title}
        </h1>
        <span className="inline-flex items-center rounded-control border border-hairline bg-panel px-2.5 py-0.5 font-mono text-xs font-bold tabular-nums text-ink-muted">
          {count.toLocaleString()} {count === 1 ? 'workflow' : 'workflows'}
        </span>
      </div>

      <p className="max-w-3xl text-pretty text-sm leading-relaxed text-ink-muted md:text-base">
        {introCopy}
      </p>
    </header>
  );
}
