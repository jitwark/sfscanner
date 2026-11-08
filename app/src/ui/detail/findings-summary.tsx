import type { Entry } from '@hub/contracts';
import { GradePill } from '../primitives/pill';
import { securitySummary, severityTag, statusToneClasses } from './security-summary-model';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function FindingsSummary({ entry }: { entry: Entry }) {
  const summary = securitySummary(entry.security);
  const tone = statusToneClasses(summary.statusTone);

  return (
    <section id="security" aria-labelledby="findings-heading" className="scroll-mt-24 space-y-4 rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="findings-heading" className="font-display text-2xl font-semibold text-ink">Security summary</h2>
          <p className="mt-1 text-sm text-ink-muted">Profile {entry.security.profile} · scanner {entry.security.scannerVersion}</p>
        </div>
        <span className="flex flex-wrap items-center gap-2" aria-label={summary.gradeAriaLabel}>
          <GradePill grade={summary.grade} />
          <span className="font-mono text-sm tabular-nums text-ink">{summary.scoreLabel}</span>
          <span className="font-mono text-xs text-ink-muted">{summary.totalFindings} reported</span>
        </span>
      </div>

      <div role="group" aria-label="Finding severity summary" className="flex flex-wrap gap-2 font-mono text-xs">
        {SEVERITIES.map((severity) => (
          <span key={severity} className="rounded border border-hairline bg-raised px-2 py-1 text-ink-muted">
            <strong className="text-ink">{summary.counts[severity]}</strong> {severity}
          </span>
        ))}
      </div>

      <div role="note" className={`rounded-control border p-3 ${tone.panel}`}>
        <p className={`font-mono text-2xs font-semibold uppercase tracking-wider ${tone.label}`}>{summary.statusLabel}</p>
        <p className="mt-1 text-sm leading-6 text-ink">{summary.statusMessage}</p>
      </div>

      <p className="text-sm leading-6 text-ink">{summary.meaning}</p>

      {summary.priorityFindings.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Highest-priority findings</h3>
          <ol className="space-y-2">
            {summary.priorityFindings.map((finding, index) => {
              const severity = severityTag(finding.severity);
              return (
                <li key={`${finding.id}:${finding.node ?? 'workflow'}:${index}`} className="min-w-0 space-y-1 text-sm">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-2xs font-bold uppercase ${severity.className}`}>{severity.label}</span>
                    <span className="font-medium text-ink">{finding.title}</span>
                    {finding.node && <span className="font-mono text-2xs text-ink-faint">· {finding.node}</span>}
                  </div>
                  {finding.fix && <p className="text-sm leading-6 text-ink-muted">{finding.fix}</p>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {summary.priorityFindings.length === 0 && (
        <div className="rounded-control border border-accent-border/40 bg-accent-dim/40 p-3">
          <p className="font-mono text-2xs font-semibold uppercase tracking-wider text-accent-text">Next step</p>
          <p className="mt-1 text-sm leading-6 text-ink">{summary.nextStep}</p>
        </div>
      )}

      {summary.remainingFindings.length > 0 && (
        <p className="text-xs leading-5 text-ink-muted">
          {summary.remainingFindings.length} more {summary.remainingFindings.length === 1 ? 'finding is' : 'findings are'} listed in the interactive view.
        </p>
      )}
    </section>
  );
}
