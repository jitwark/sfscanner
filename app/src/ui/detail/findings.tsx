import type { Entry, PublicFinding } from '@hub/contracts';
import { GradePill } from '../primitives/pill';
import { securitySummary, severityTag, statusToneClasses } from './security-summary-model';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function Findings({ entry }: { entry: Entry }) {
  const summary = securitySummary(entry.security);
  const tone = statusToneClasses(summary.statusTone);

  return (
    <section aria-labelledby="findings-heading" className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">Deterministic scanner result</p>
          <h2 id="findings-heading" className="mt-1 font-display text-2xl font-semibold text-ink">Security summary</h2>
          <p className="mt-2 text-sm text-ink-muted">Profile {entry.security.profile} · scanner {entry.security.scannerVersion}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label={summary.gradeAriaLabel}>
          <GradePill grade={summary.grade} />
          <span className="font-mono text-sm tabular-nums text-ink">{summary.scoreLabel}</span>
          <span className="font-mono text-xs text-ink-muted">{summary.totalFindings} reported</span>
        </div>
      </div>

      <div role="group" aria-label="Finding severity summary" className="flex flex-wrap gap-2 text-xs font-mono">
        {SEVERITIES.map((severity) => (
          <span key={severity} className="rounded border border-hairline bg-panel px-2 py-1 text-ink-muted">
            <strong className="text-ink">{summary.counts[severity]}</strong> {severity}
          </span>
        ))}
      </div>

      <div role="note" className={`rounded-control border p-3 ${tone.panel}`}>
        <p className={`font-mono text-2xs font-semibold uppercase tracking-wider ${tone.label}`}>{summary.statusLabel}</p>
        <p className="mt-1 text-sm leading-6 text-ink">{summary.statusMessage}</p>
      </div>

      <p className="text-sm leading-6 text-ink">{summary.meaning}</p>

      <div className="rounded-control border border-accent-border/40 bg-accent-dim/40 p-3">
        <p className="font-mono text-2xs font-semibold uppercase tracking-wider text-accent-text">Next step</p>
        <p className="mt-1 text-sm leading-6 text-ink">{summary.nextStep}</p>
      </div>

      {summary.priorityFindings.length > 0 ? (
        <div role="region" aria-label="Priority security findings" className="grid gap-3 md:grid-cols-3">
          {summary.priorityFindings.map((finding, index) => (
            <PriorityCard key={`${finding.id}:${finding.node ?? 'workflow'}:${index}`} finding={finding} />
          ))}
        </div>
      ) : (
        <p className="rounded-control border border-hairline bg-panel p-4 text-sm leading-6 text-ink-muted" role="note">
          No individual findings were published. Treat that as missing evidence, not as proof of safety.
        </p>
      )}

      {summary.remainingFindings.length > 0 && (
        <details className="group/findings border-y border-hairline open:border-hairline-strong">
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-control px-2 text-sm font-medium text-ink transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open/findings:bg-raised group-open/findings:text-accent-text">
            <span aria-hidden="true" className="mr-2 text-ink-faint transition-transform group-open/findings:rotate-90">›</span>
            View remaining {summary.remainingFindings.length} {summary.remainingFindings.length === 1 ? 'finding' : 'findings'}
          </summary>
          <div className="divide-y divide-hairline">
            {summary.remainingFindings.map((finding, index) => (
              <FindingRow key={`${finding.id}:${finding.node ?? 'workflow'}:${index}`} finding={finding} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function PriorityCard({ finding }: { finding: PublicFinding }) {
  const severity = severityTag(finding.severity);
  return (
    <article className="rounded-control border border-hairline bg-raised p-4">
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-2xs font-bold uppercase ${severity.className}`}>{severity.label}</span>
        <span className="font-mono text-2xs uppercase text-ink-faint">Priority</span>
      </div>
      <h3 className="mt-3 font-display text-lg font-semibold text-ink">{finding.title}</h3>
      <p className="mt-2 text-sm leading-6 text-ink-muted"><strong className="font-medium text-ink">Why:</strong> {finding.why}</p>
      <p className="mt-2 text-sm leading-6 text-ink-muted"><strong className="font-medium text-ink">Next step:</strong> {finding.fix}</p>
      {finding.node && <p className="mt-3 font-mono text-2xs text-ink-faint">Node: {finding.node}</p>}
    </article>
  );
}

function FindingRow({ finding }: { finding: PublicFinding }) {
  const severity = severityTag(finding.severity);
  return (
    <details className="group/finding py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-control px-2 text-sm font-medium text-ink transition-colors marker:hidden hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50 active:bg-panel group-open/finding:bg-raised group-open/finding:text-accent-text">
        <span className="text-ink-faint transition-transform group-open/finding:rotate-90" aria-hidden="true">›</span>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-2xs font-bold uppercase ${severity.className}`}>{severity.label}</span>
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
