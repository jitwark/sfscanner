import type { ReactNode } from 'react';

type ReadinessSectionProps = {
  title: string;
  count?: number;
  icon: string;
  children: ReactNode;
};

export function ReadinessSection({ title, count, icon, children }: ReadinessSectionProps) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-control border border-hairline/80 bg-raised/50 p-3.5">
      <h3 className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider text-ink">
        <span aria-hidden="true" className="text-sm">{icon}</span>
        <span>{title}</span>
        {count !== undefined && <span className="text-ink-muted">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

export function ReadinessList({ children }: { children: ReactNode }) {
  return <ul className="flex min-w-0 flex-col gap-1.5 text-xs text-ink-muted">{children}</ul>;
}

/**
 * Plan 6.6: a row with no authorized body keeps the compatibility, hostname,
 * replaceable-value, write-action and AI-model values derived before that body
 * went missing, and the section-level disclaimer above them does not travel to
 * the values. The note travels with each affected group instead, so a target
 * version cannot be read as a current claim and a hostname cannot be read as a
 * current derivation.
 *
 * A plain paragraph, not `role="alert"`: this is static copy in a group the
 * reader has already reached, and turning five value groups into five live
 * regions would announce on arrival and re-announce on every re-render. The one
 * real alert stays the section-level warning in `readiness-signals.tsx`.
 */
export function HistoricalDerivationNote({ about }: { about: string }) {
  return (
    <p className="text-xs leading-5 text-sev-medium">
      Historical derivation: this entry has no workflow JSON for the current engine to analyse, so {about} come from an earlier derivation and are not current results. Confirm them against the upstream workflow before relying on them.
    </p>
  );
}
