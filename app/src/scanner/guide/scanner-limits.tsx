import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { EyeOff, Gauge, Layers } from 'lucide-react';
import { MAX_WORKFLOW_BYTES_LABEL } from '../scanner-input-validation';

const CANNOT: string[] = [
  'Prove a workflow is safe. A LOW grade means these checks found nothing, not that nothing is there. Absence of findings is not a certificate.',
  'Judge intent. A request to a normal-looking host is indistinguishable from a request to an attacker-controlled one that happens to look normal.',
  'Tell you whether the service on the other end deserves your data.',
  'Tell you whether the workflow will actually run. Nothing here is executed — the analysis is entirely static. Whether a workflow will work for you is what the catalogue readiness report answers.',
  'Know your n8n version, your installed community packages, or your instance settings, so it cannot flag version-specific issues.',
  'See anything a workflow builds at runtime. A URL assembled from an expression is only partly visible before it runs.',
];

export function ScannerLimits() {
  return (
    <section aria-labelledby="limits-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <h2 id="limits-heading" className="font-display text-lg font-semibold text-ink">
        What it cannot tell you
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Worth stating plainly, because a security tool that only advertises what it catches is
        misleading.
      </p>
      <ul className="mt-4 flex max-w-2xl flex-col gap-2">
        {CANNOT.map((item) => (
          <li key={item} className="flex gap-2.5 text-sm text-ink-muted">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-control border border-hairline bg-raised p-3">
          <div className="flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-accent-text" aria-hidden />
            <h3 className="font-display text-xs font-semibold text-ink">Default scan</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            The shipped profile reads workflow structure and settings. It does not parse JavaScript
            or Python, track value flow, or report AI-agent checks: those belong to the hardened
            profile, which is defined but not admitted.
          </p>
          <p className="mt-1.5 text-xs text-ink-faint">
            The catalogue covers the node families listed in the rule reference; an unmodelled node
            is reported as degraded coverage, never silently treated as clean.
          </p>
        </div>

        <div className="rounded-control border border-hairline bg-raised p-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5 text-accent-text" aria-hidden />
            <h3 className="font-display text-xs font-semibold text-ink">Input limits</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            Up to <strong className="font-semibold text-ink">{MAX_WORKFLOW_BYTES_LABEL}</strong> of JSON and{' '}
            <strong className="font-semibold text-ink">{DEFAULT_SCANNER_LIMITS.maxNodes.toLocaleString('en-US')} nodes</strong>. Above either, the scan
            stops rather than freezing your tab.
          </p>
          <p className="mt-1.5 text-xs text-ink-faint">
            There is no 24-node workflow cap. The admission limit is 5,000 nodes; 5,001 is refused
            with a node-limit error rather than truncated.
          </p>
        </div>

        <div className="rounded-control border border-hairline bg-raised p-3">
          <div className="flex items-center gap-2">
            <EyeOff className="h-3.5 w-3.5 text-accent-text" aria-hidden />
            <h3 className="font-display text-xs font-semibold text-ink">Workflow content stays local</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            The scanner worker does not send workflow content to a remote service or persist it through
            this app. Its shipped code contains no network primitive. The page keeps the workflow only
            in memory for the current scan; normal page assets may still use the browser network.
          </p>
          <p className="mt-1.5 text-xs text-ink-faint">
            This is verifiable: open your browser network panel and scan. You should see no scanner
            request carrying workflow content.
          </p>
        </div>
      </div>

      <p className="mt-6 max-w-2xl border-t border-hairline pt-4 text-xs text-ink-faint">
        The report is advisory. It is a reading of one JSON file, not an audit, a certification, or a
        statement about the person who wrote the workflow. Treat a finding as a question to answer,
        not an accusation.
      </p>
    </section>
  );
}
