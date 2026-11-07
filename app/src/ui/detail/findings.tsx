import type { Entry, PublicFinding, Severity } from '@hub/contracts';
import { GradePill } from '../primitives/pill';

type FindingsProps = { entry: Entry };

const ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

export function Findings({ entry }: FindingsProps) {
  const findings = [...entry.security.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const priority = findings.filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH').slice(0, 3);
  const counts = entry.security.counts;
  return (
    <section aria-labelledby="findings-heading" className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">Deterministic scanner result</p>
          <h2 id="findings-heading" className="mt-1 font-display text-2xl font-semibold text-ink">Security summary</h2>
          <p className="mt-2 text-sm text-ink-muted">Profile {entry.security.profile} · scanner {entry.security.scannerVersion}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label={`Scanner grade ${entry.security.grade}, score ${entry.security.score} out of 100`}>
          <GradePill grade={entry.security.grade} />
          <span className="font-mono text-sm tabular-nums text-ink">{entry.security.score}/100</span>
          <span className="font-mono text-xs text-ink-muted">{findings.length} reported</span>
        </div>
      </div>
      <div role="group" aria-label="Finding severity summary" className="flex flex-wrap gap-2 text-xs font-mono">
        {(['critical', 'high', 'medium', 'low', 'info'] as const).map((severity) => (
          <span key={severity} className="rounded border border-hairline bg-panel px-2 py-1 text-ink-muted">
            <strong className="text-ink">{counts[severity]}</strong> {severity}
          </span>
        ))}
      </div>
      {findings.length === 0 ? (
        <p className="border border-hairline bg-panel p-4 text-sm text-ink-muted">No findings were reported by the scanner profile.</p>
      ) : (
        <>
          {priority.length > 0 && (
            <div role="region" aria-label="Priority security findings" className="grid gap-3 md:grid-cols-3">
              {priority.map((finding, index) => <PriorityCard key={`${finding.id}:${index}`} finding={finding} />)}
            </div>
          )}
          <details className="group/findings border-y border-hairline open:border-hairline-strong">
            <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-control px-2 text-sm font-medium text-ink transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open/findings:bg-raised group-open/findings:text-accent-text">
              <span aria-hidden="true" className="mr-2 text-ink-faint transition-transform group-open/findings:rotate-90">›</span>
              View all findings ({findings.length})
            </summary>
            <div className="divide-y divide-hairline">
              {findings.map((finding, index) => <FindingRow key={`${finding.id}:${finding.node ?? 'workflow'}:${index}`} finding={finding} open={index === 0 && finding.severity === 'CRITICAL'} />)}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function PriorityCard({ finding }: { finding: PublicFinding }) {
  return (
    <article className="rounded-control border border-hairline bg-raised p-4">
      <div className="flex items-center justify-between gap-2">
        <GradePill grade={finding.severity === 'INFO' ? 'UNKNOWN' : finding.severity} />
        <span className="font-mono text-2xs uppercase text-ink-faint">Priority</span>
      </div>
      <h3 className="mt-3 font-display text-lg font-semibold text-ink">{finding.title}</h3>
      <p className="mt-2 text-sm leading-6 text-ink-muted"><strong className="font-medium text-ink">Why:</strong> {finding.why}</p>
      <p className="mt-2 text-sm leading-6 text-ink-muted"><strong className="font-medium text-ink">Next step:</strong> {finding.fix}</p>
      {finding.node && <p className="mt-3 font-mono text-2xs text-ink-faint">Node: {finding.node}</p>}
    </article>
  );
}

function FindingRow({ finding, open }: { finding: PublicFinding; open: boolean }) {
  return (
    <details open={open} className="group/finding py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-control px-2 text-sm font-medium text-ink transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open/finding:bg-raised group-open/finding:text-accent-text">
        <span className="text-ink-faint transition-transform group-open/finding:rotate-90" aria-hidden="true">›</span>
        <GradePill grade={finding.severity === 'INFO' ? 'UNKNOWN' : finding.severity} />
        <span>{finding.title}</span>
        {finding.node && <span className="ml-auto truncate font-mono text-xs text-ink-muted">{finding.node}</span>}
      </summary>
      <div className="ml-7 mt-3 grid gap-3 border-l border-hairline pl-4 text-sm leading-6 text-ink-muted sm:grid-cols-2">
        <p><strong className="font-medium text-ink">Why:</strong> {finding.why}</p>
        <p><strong className="font-medium text-ink">Fix:</strong> {finding.fix}</p>
      </div>
    </details>
  );
}
