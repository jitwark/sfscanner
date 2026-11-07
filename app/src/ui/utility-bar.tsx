/**
 * Global technical utility bar anchored at the very top of the page.
 */
export function UtilityBar() {
  return (
    <aside
      aria-label="Security and telemetry notice"
      className="hidden h-8 w-full border-b border-hairline bg-raised text-2xs font-mono font-bold uppercase tracking-wider text-ink-muted sm:block"
    >
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 bg-accent" aria-hidden="true" />
          <span>Local client-side execution · zero telemetry · open source</span>
        </div>
        <div className="flex items-center gap-4 text-2xs">
          <span className="text-ink">v0.1.0</span>
        </div>
      </div>
    </aside>
  );
}
