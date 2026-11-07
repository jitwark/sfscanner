import type { Entry, Severity } from '@hub/contracts';
import { GradePill } from '../primitives/pill';

const ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

/**
 * What the scanner found, without what it said about each one.
 *
 * `Findings` renders every finding's `why` and `fix` behind disclosures. That is
 * right on a page a reader opened deliberately and wrong on 12,923 generated
 * ones: it measures 14 KB each, or 174 MB across the catalogue, against a 1 GB
 * host ceiling.
 *
 * The grade, the score, the per-severity counts and the titles of the worst few
 * are the facts a crawler and a scanning reader need. The interactive page,
 * linked from here, carries the rest.
 */
export function FindingsSummary({ entry, interactiveHref }: { entry: Entry; interactiveHref: string }) {
  const findings = [...entry.security.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const worst = findings.slice(0, 5);
  const counts = entry.security.counts;

  return (
    <section id="security" aria-labelledby="findings-heading" className="scroll-mt-24 space-y-3 rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="findings-heading" className="font-display text-2xl font-semibold text-ink">Security summary</h2>
        <span className="flex items-center gap-2" aria-label={`Scanner grade ${entry.security.grade}, score ${entry.security.score} out of 100`}>
          <GradePill grade={entry.security.grade} />
          <span className="font-mono text-sm tabular-nums text-ink">{entry.security.score}/100</span>
        </span>
      </div>
      <p className="text-sm text-ink-muted">
        Profile {entry.security.profile} · scanner {entry.security.scannerVersion} · {findings.length} reported
      </p>
      <div role="group" aria-label="Finding severity summary" className="flex flex-wrap gap-2 font-mono text-xs">
        {SEVERITIES.map((severity) => (
          <span key={severity} className="rounded border border-hairline bg-raised px-2 py-1 text-ink-muted">
            <strong className="text-ink">{counts[severity]}</strong> {severity}
          </span>
        ))}
      </div>
      {worst.length > 0 && (
        <ul className="space-y-1 text-sm text-ink-muted">
          {worst.map((item, index) => (
            <li key={`${item.id}:${index}`}>
              <span className="font-mono text-2xs uppercase text-ink-faint">{item.severity}</span>{' '}
              {item.title}
              {item.node && <span className="font-mono text-2xs text-ink-faint"> · {item.node}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        <a href={interactiveHref} className="text-accent-text underline">
          {findings.length > worst.length
            ? `Read all ${findings.length} findings, with why and how to fix each`
            : 'Read each finding, with why and how to fix it'}
        </a>
      </p>
    </section>
  );
}
