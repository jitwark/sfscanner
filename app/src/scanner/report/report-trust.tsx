import { BookOpen, CircleHelp, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { scanAnalysisPresentation } from '../analysis-language';
import { safeReportText } from './report-safe-content';
import { scannerRuleReferenceUrl } from '../../ui/product-links';

export function scannerRuleReferenceHref(): string | null {
  return scannerRuleReferenceUrl();
}
const ANALYSIS_STATUSES = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'] as const;

function v2Model(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  try {
    const candidate = scan as unknown as Partial<ScannerReportModelV2>;
    const v2 = candidate.v2;
    if (v2?.schemaVersion !== 'scanner-result-v2'
      || typeof v2.engine?.id !== 'string'
      || typeof v2.engine.version !== 'string'
      || typeof v2.engine.buildDigest !== 'string'
      || typeof v2.profile?.id !== 'string'
      || typeof v2.profile.version !== 'string'
      || typeof v2.ruleset?.id !== 'string'
      || typeof v2.ruleset.version !== 'string'
      || typeof v2.ruleset.digest !== 'string'
      || typeof v2.semantics?.id !== 'string'
      || typeof v2.semantics.version !== 'string'
      || typeof v2.semantics.digest !== 'string'
      || typeof v2.analysis?.status !== 'string'
      || !ANALYSIS_STATUSES.some((status) => status === v2.analysis.status)
      || !Array.isArray(v2.findings)
      || v2.findings.some((finding) => {
        if (finding === null || typeof finding !== 'object' || Array.isArray(finding) || !('effect' in finding)) return true;
        const effect = finding.effect;
        return effect !== 'REPORT_ONLY' && effect !== 'SCORING';
      })
      || !('assessment' in candidate)
      || candidate.assessment !== null && (typeof candidate.assessment !== 'object' || Array.isArray(candidate.assessment))) {
      return undefined;
    }
    return candidate as ScannerReportModelV2;
  } catch {
    return undefined;
  }
}

function IdentityValue({ label, value }: { label: string; value: string }) {
  return <div><dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">{label}</dt><dd className="mt-1 break-all font-mono text-ink">{safeReportText(value, 80)}</dd></div>;
}

function IdentityDetails({ model }: { model: ScannerReportModelV2 }) {
  const { engine, profile, ruleset, semantics } = model.v2;
  return (
    <div className="mt-4 rounded-control border border-hairline bg-raised/40 p-3">
      <h4 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Scanner identity</h4>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <IdentityValue label="Engine identity" value={`${engine.id} · ${engine.version}`} />
        <IdentityValue label="Engine build digest" value={engine.buildDigest} />
        <IdentityValue label="Profile identity" value={`${profile.id} · ${profile.version}`} />
        <IdentityValue label="Ruleset identity" value={`${ruleset.id} · ${ruleset.version}`} />
        <IdentityValue label="Ruleset digest" value={ruleset.digest} />
        <IdentityValue label="Semantics identity" value={`${semantics.id} · ${semantics.version}`} />
        <IdentityValue label="Semantics digest" value={semantics.digest} />
      </dl>
      <p className="mt-3 text-xs leading-5 text-ink-muted">These identities describe the native scanner result. This report does not assert signature verification, trust-store admission, or SBOM authority.</p>
    </div>
  );
}

function AuthorityDetails({ model }: { model: ScannerReportModelV2 }) {
  const hasReportOnly = model.v2.findings.some((finding) => finding.effect === 'REPORT_ONLY');
  const hasNative = model.v2.findings.some((finding) => finding.effect === 'SCORING');
  return (
    <div className="mt-4 rounded-control border border-hairline bg-raised/40 p-3">
      <h4 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Evidence authority</h4>
      <p className="mt-1 text-xs leading-5 text-ink">
        {hasNative ? 'Native assessment evidence is represented separately from report-only observations.' : 'This result does not include native assessment evidence.'}{' '}
        {hasReportOnly ? 'Report-only evidence is advisory and does not change risk grade.' : 'No report-only evidence is present in this result.'}
      </p>
    </div>
  );
}

export function ReportTrust({ scan }: { scan: ScanWorkflowResult }) {
  const model = v2Model(scan);
  const presentation = scanAnalysisPresentation(scan);
  const v2Incomplete = Boolean(model && presentation.label !== 'Analysis complete');
  const example = !v2Incomplete && scan.scannerVersion.trim() && scan.findings.find((finding) => finding.policyId.trim());

  return (
    <aside aria-labelledby="scanner-trust-heading" className="mt-4 rounded-control border border-accent-border/30 bg-accent-dim/40 p-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
        <div>
          <h3 id="scanner-trust-heading" className="font-display text-base font-semibold text-ink">How to read this result</h3>
          <p className="mt-1 font-mono text-2xs text-ink-muted">Scanner build: {safeReportText(scan.scannerVersion, 80)}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">
            <BookOpen className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
            What this result means
          </h4>
          <p className="mt-1 text-sm leading-6 text-ink">
            These are deterministic rule matches against the workflow data available to the local scanner. They identify areas for review and preserve the report&apos;s redacted evidence.
          </p>
        </div>
        <div>
          <h4 className="flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">
            <CircleHelp className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
            What this result does not prove
          </h4>
          <p className="mt-1 text-sm leading-6 text-ink">
            This is not proof of runtime behavior or safety. Node-model coverage can be partial, and pattern-based checks can miss unrecognized secrets or behavior, so review credentials, downstream services, and host assumptions separately.
          </p>
        </div>
      </div>

      {model ? <><IdentityDetails model={model} /><AuthorityDetails model={model} /></> : null}
      <div className="mt-4 rounded-control border border-hairline bg-raised/40 p-3">
        <h4 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Report a false positive or security concern</h4>
        <p className="mt-1 text-sm leading-6 text-ink">
          If you spot a false positive or a security concern, use the private removal and security channel to report it. Do not disclose credentials, secrets, or customer data publicly.{' '}
          <Link href="/takedown/#security" className="text-accent-text underline underline-offset-2">Report it privately</Link>.
        </p>
      </div>

      {example ? (
        <details className="mt-4 rounded-control border border-hairline bg-raised/40 p-3">
          <summary className="cursor-pointer list-inside font-mono text-xs font-semibold text-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-border">
            Safe synthetic result example
          </summary>
          <p className="mt-2 text-xs leading-5 text-ink-muted">
            This example uses only result metadata already present here; it is not copied from the workflow.
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">Scanner build</dt>
              <dd className="mt-1 break-all font-mono text-ink">{safeReportText(scan.scannerVersion, 80)}</dd>
            </div>
            <div>
              <dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">Expected rule match</dt>
              <dd className="mt-1 break-all font-mono text-ink">{safeReportText(example.policyId, 120)}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </aside>
  );
}
