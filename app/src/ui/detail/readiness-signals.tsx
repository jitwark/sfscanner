'use client';

import type { Entry } from '@hub/contracts';
import { READINESS_UNSCANNED_DISCLAIMER } from '@hub/contracts';
import { CompatibilityList } from './readiness/compatibility-list';
import { CredentialList, ReplacementList, WriteActionList } from './readiness/replacement-list';
import { HistoricalDerivationNote } from './readiness/readiness-section';
import { HostList } from './readiness/host-list';

type ReadinessSignalsProps = {
  entry: Entry;
};

export function ReadinessSignals({ entry }: ReadinessSignalsProps) {
  const readiness = entry.readiness;
  const hasPublishedReadiness = readiness !== undefined;
  const hostnames = entry.hostnames;
  const hasAI = Boolean(entry.structure.hasAI || readiness?.aiModel?.present);
  const aiModelName = readiness?.aiModel?.model;

  const credentials = readiness?.credentials ?? [];
  const writeActions = readiness?.writeActions ?? [];
  const hasSubWorkflow = Boolean(entry.structure.isSubWorkflow || readiness?.isSubWorkflow);
  const hasPinnedData = Boolean(readiness?.pinnedData?.present);
  const isPartial = entry.structure.partial === true;
  // No workflow JSON was available for this entry, so an empty `credentials`
  // list here means unknown, not "none required". It is a third state, not a
  // variant of "no report": one of them publishes a report and says it could
  // not be computed.
  const isUnscanned = readiness?.analysis === 'unscanned';
  const showIncompleteWarning = isPartial || !readiness || isUnscanned;
  const hasAnySignals = hasAI || hasSubWorkflow || hasPinnedData || Boolean(entry.compatibility) ||
    credentials.length > 0 ||
    (readiness?.replaceableValues.length ?? 0) > 0 ||
    writeActions.length > 0 ||
    (readiness?.extraPackages.length ?? 0) > 0 ||
    (readiness?.versionNotes.length ?? 0) > 0 ||
    Boolean(hostnames && (hostnames.literal.length > 0 || hostnames.dynamic.length > 0 || hostnames.undeterminable > 0));

  return (
    <section aria-labelledby="readiness-heading" className="space-y-4 rounded-panel border border-hairline bg-panel p-5">
      <div className="space-y-1">
        <h2 id="readiness-heading" className="font-display text-xl font-semibold text-ink">
          Before you run
        </h2>
        <p className="font-mono text-xs text-ink-muted">Deterministic pre-run checks</p>
      </div>

      {showIncompleteWarning && (
        <div role="alert" className="flex items-start gap-2 rounded-control border border-sev-medium bg-sev-medium/10 px-3 py-2 text-sm leading-6 text-sev-medium">
          <span aria-hidden="true">⚠</span>
          <span>{isUnscanned
            ? <>{READINESS_UNSCANNED_DISCLAIMER}{isPartial ? ' This metadata-only entry also has only partial structure data.' : ''}</>
            : isPartial
              ? <>Workflow body is unavailable. This metadata-only entry has only partial structure data; do not treat it as ready to run. Review the upstream workflow before importing.</>
              : <>No pre-run readiness report is published for this entry. It is not ready to run based on the published data; review the upstream workflow before importing.</>}</span>
        </div>
      )}
      {!showIncompleteWarning && !hasAnySignals && (
        <p className="rounded-control border border-hairline bg-raised/50 p-3 text-sm leading-6 text-ink-muted">
          {hasPublishedReadiness
            ? 'No pre-run signals were detected in the published readiness report. Review the upstream workflow before running it.'
            : 'No pre-run readiness signals were detected for this entry.'}
        </p>
      )}
      {hasAnySignals && <div className="grid min-w-0 grid-cols-1 gap-4">
        {hasAI && (
          <section aria-label="AI model" className="flex min-w-0 flex-col gap-1.5 rounded-control border border-hairline/80 bg-raised/50 p-3.5">
            <h3 className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider text-ink"><span aria-hidden="true">◈</span> AI / LLM model</h3>
            {isUnscanned && <HistoricalDerivationNote about="the AI model details in this card" />}
            <p className="break-words text-xs text-ink-muted">{aiModelName ? <>Configured model target: <strong className="font-mono text-ink">{aiModelName}</strong></> : 'Workflow connects to an AI or model provider node; no specific model is pinned in this file.'}</p>
          </section>
        )}
        <CredentialList credentials={credentials} isUnscanned={isUnscanned} />
        <ReplacementList values={readiness?.replaceableValues ?? []} isUnscanned={isUnscanned} />
        <WriteActionList actions={writeActions} isUnscanned={isUnscanned} />
        <HostList hostnames={hostnames} isUnscanned={isUnscanned} />
        <CompatibilityList readiness={readiness} compatibility={entry.compatibility} isUnscanned={isUnscanned} />
      </div>}

      {/* Pinned Data Warning */}
      {hasSubWorkflow && (
        <div role="note" className="flex items-start gap-2 rounded-control border border-hairline bg-raised/50 px-3 py-2 text-xs text-ink-muted"><span aria-hidden="true">↳</span><span>This is a sub-workflow and can only be started by a parent workflow; importing it alone will not start it.</span></div>
      )}
      {hasPinnedData && (
        <div role="alert" className="flex items-start gap-2 rounded-control border border-sev-medium bg-sev-medium/10 px-3 py-2 text-xs text-sev-medium"><span aria-hidden="true">⚠</span><span>This workflow contains {readiness?.pinnedData.nodeCount} node(s) with sample / pinned test execution data. Verify or clear test data prior to production use.</span>
        </div>
      )}
    </section>
  );
}
