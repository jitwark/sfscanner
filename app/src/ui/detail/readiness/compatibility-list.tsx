import type { EntryReadiness, N8nCompatibility } from '@hub/contracts';
import { HistoricalDerivationNote, ReadinessList, ReadinessSection } from './readiness-section';

export function CompatibilityList({ readiness, compatibility, isUnscanned = false }: { readiness?: EntryReadiness; compatibility?: N8nCompatibility; isUnscanned?: boolean }) {
  if ((!readiness || (readiness.extraPackages.length === 0 && readiness.versionNotes.length === 0)) && !compatibility) return null;
  return (
    <ReadinessSection title="Compatibility notes" icon="⚙">
      {isUnscanned && <HistoricalDerivationNote about="the target version, its status, and every other detail in this card" />}
      {compatibility && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-hairline bg-panel px-2 py-1 text-xs font-mono text-ink">n8n {compatibility.targetVersion}</span>
            <span className="rounded border border-accent-border/30 bg-accent/10 px-2 py-1 text-xs font-mono text-ink">{compatibilityLabel(compatibility.status)}</span>
          </div>
          <dl className="grid gap-2 text-xs text-ink-muted sm:grid-cols-2">
            <div><dt className="font-semibold text-ink">Source</dt><dd className="break-words">{compatibility.source}</dd></div>
            <div><dt className="font-semibold text-ink">Checked</dt><dd><time dateTime={compatibility.checkedAt}>{formatCheckedAt(compatibility.checkedAt)}</time></dd></div>
          </dl>
          {compatibility.reasons.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold text-ink">Published reasons</h4>
              <ReadinessList>{compatibility.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ReadinessList>
            </div>
          ) : <p className="text-xs leading-5 text-ink-muted">No compatibility reason was published.</p>}
          <p className="text-xs leading-5 text-ink-muted">This is a static file check, not a completed n8n execution test.</p>
          {compatibility.blockers.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-ink">Review blockers</h4>
              <ReadinessList>{compatibility.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}</ReadinessList>
            </div>
          )}
        </div>
      )}
      {readiness && readiness.extraPackages.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-ink">Extra node packages</h4>
          <ReadinessList>{readiness.extraPackages.map((pkg, index) => <li key={`${pkg}-${index}`} className="font-mono">{pkg}</li>)}</ReadinessList>
        </div>
      )}
      {readiness && readiness.versionNotes.length > 0 && (
        <div className={readiness.extraPackages.length > 0 ? 'mt-2' : undefined}>
          <h4 className="text-xs font-semibold text-ink">Version and legacy notes</h4>
          <ReadinessList>{readiness.versionNotes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}</ReadinessList>
        </div>
      )}
    </ReadinessSection>
  );
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function compatibilityLabel(status: N8nCompatibility['status']): string {
  if (status === 'likely-compatible') return 'Likely compatible';
  if (status === 'review-required') return 'Review before import';
  return 'Unknown';
}
