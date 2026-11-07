import type { ReportPrerequisitesModel, ReportPrerequisiteEvidence } from '../prerequisite-sidecar';

const chip = 'rounded-control border border-hairline bg-raised px-2.5 py-1 font-mono text-2xs text-ink-muted';
const mono = 'font-mono text-xs text-ink';

function Evidence({ rows }: { rows: readonly ReportPrerequisiteEvidence[] }) {
  return <ul className="mt-2 space-y-1 text-xs text-ink-muted">
    {rows.map((row) => <li key={`${row.pointer}-${row.node}`}>
      <span className={mono}>{row.node}</span> · {row.nodeType} · v{row.typeVersion ?? 'UNKNOWN'} ·{' '}
      <span className={mono}>{row.pointer}</span>
    </li>)}
  </ul>;
}

function EmptyCategory({ children }: { children: string }) {
  return <p className="mt-2 text-sm text-ink-muted">{children} This is an empty observation set, not proof that none are required.</p>;
}

function Available({ model }: { model: Extract<ReportPrerequisitesModel, { status: 'AVAILABLE' }> }) {
  const counts = [
    ['Credentials', model.credentials.length], ['Community nodes', model.communityNodes.length],
    ['Integrations', model.integrations.length], ['Subworkflows', model.subworkflows.length],
    ['Environment references', model.environment.length], ['Malformed nodes', model.malformed],
  ] as const;
  return <>
    <div className="mt-4 flex items-start gap-2 rounded-control border border-accent-border/40 bg-accent-dim p-3 text-sm text-ink-muted" role="note">
      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <p>Observations come from this workflow export. Credential secrets, package installation, ownership, environment values and live availability remain unknown.</p>
    </div>
    <div className="mt-4 flex flex-wrap gap-2" aria-label="Prerequisite observation counts">
      {counts.map(([label, count]) => <span key={label} className={chip}>{label}: {count}</span>)}
      <span className={chip}>Inventory truncated: {model.inventoryTruncated ? 'yes' : 'no'}</span>
      <span className={chip}>Computed environment access: {model.environmentIncomplete.computed ? 'yes' : 'no'}</span>
      <span className={chip}>Environment evidence omitted: {model.environmentIncomplete.omitted ? 'yes' : 'no'}</span>
    </div>
    <p className="mt-3 break-all font-mono text-2xs text-ink-faint">Accepted input SHA-256: {model.inputSha256} · {model.utf8Bytes.toLocaleString('en-US')} bytes</p>

    <div className="mt-5 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Credential references</h3>
        {model.credentials.length === 0 ? <EmptyCategory>No credential rows were observed.</EmptyCategory> : <ul className="mt-2 space-y-2">
          {model.credentials.map((row) => <li key={`${row.pointer}-${row.node}`} className="rounded-control border border-hairline bg-raised/30 p-3 text-sm">
            <p className="text-ink"><span className={mono}>{row.credentialType}</span>{row.credentialName ? ` · ${row.credentialName}` : ''} · {row.reference}</p>
            <p className="mt-1 text-xs text-ink-muted">Node: <span className={mono}>{row.node}</span> · {row.nodeType}</p>
            <p className="mt-1 break-all font-mono text-xs text-ink-muted">{row.pointer}</p>
            <p className="mt-1 text-xs text-ink-muted">Offline validity: {row.offlineValidity} · Ownership: {row.ownership}</p>
          </li>)}
        </ul>}
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Community packages</h3>
        {model.communityNodes.length === 0 ? <EmptyCategory>No community-node rows were observed.</EmptyCategory> : <ul className="mt-2 space-y-2">
          {model.communityNodes.map((row) => <li key={`${row.packageName ?? 'NONE'}-${row.nodeTypes.join('-')}`} className="rounded-control border border-hairline bg-raised/30 p-3 text-sm">
            <p className="text-ink"><span className={mono}>{row.packageName ?? 'Package name UNKNOWN'}</span></p>
            <p className="mt-1 text-xs text-ink-muted">Node types: {row.nodeTypes.join(', ') || 'UNKNOWN'} · Type versions: {row.typeVersions.join(', ') || 'UNKNOWN'}</p>
            <p className="mt-1 text-xs text-ink-muted">Package version: {row.packageVersion ?? 'UNKNOWN'} · Installed: {row.installed}</p>
            <Evidence rows={row.evidence} />
          </li>)}
        </ul>}
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Integrations</h3>
        {model.integrations.length === 0 ? <EmptyCategory>No integration rows were observed.</EmptyCategory> : <ul className="mt-2 space-y-2">
          {model.integrations.map((row) => <li key={row.nodeType} className="rounded-control border border-hairline bg-raised/30 p-3 text-sm">
            <p className="text-ink"><span className={mono}>{row.service}</span> · {row.nodeType}</p>
            <p className="mt-1 text-xs text-ink-muted">Nodes: {row.nodes.join(', ')} · Credential types: {row.credentialTypes.join(', ') || 'none observed'} · Live access: UNKNOWN</p>
            <Evidence rows={row.evidence} />
          </li>)}
        </ul>}
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Subworkflows</h3>
        {model.subworkflows.length === 0 ? <EmptyCategory>No subworkflow rows were observed.</EmptyCategory> : <ul className="mt-2 space-y-2">
          {model.subworkflows.map((row) => <li key={`${row.pointer}-${row.node}`} className="rounded-control border border-hairline bg-raised/30 p-3 text-sm">
            <p className="text-ink">Node: <span className={mono}>{row.node}</span> · Resolution: {row.resolution}</p>
            <p className="mt-1 break-all font-mono text-xs text-ink-muted">{row.pointer}</p>
            <p className="mt-1 text-xs text-ink-muted">Target existence: {row.targetExistence}</p>
          </li>)}
        </ul>}
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Environment references</h3>
        {model.environment.length === 0 ? <EmptyCategory>No environment rows were observed.</EmptyCategory> : <ul className="mt-2 space-y-2">
          {model.environment.map((row) => <li key={`${row.pointer}-${row.namespace}-${row.name}`} className="rounded-control border border-hairline bg-raised/30 p-3 text-sm">
            <p className="text-ink"><span className={mono}>${row.namespace === 'ENV' ? 'env' : 'vars'}.{row.name}</span> · Node: {row.evidence.node}</p>
            <p className="mt-1 break-all font-mono text-xs text-ink-muted">{row.pointer}</p>
            <p className="mt-1 text-xs text-ink-muted">Environment value: {row.value} · Environment availability: {row.availability}</p>
          </li>)}
        </ul>}
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Export provenance</h3>
        <p className="mt-2 text-sm text-ink-muted">Source: {model.provenance.source} · pointer <span className={mono}>{model.provenance.pointer}</span></p>
        <p className="mt-1 text-sm text-ink-muted">Repository: {model.provenance.repository} · Commit: {model.provenance.commit} · Licence: {model.provenance.licence} · Verification: {model.provenance.verification}</p>
      </div>

      <div>
        <h3 className="font-display text-base font-semibold text-ink">Unknowns that remain</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">{model.unknowns.map((unknown) => <li key={unknown}>{unknown}</li>)}</ul>
      </div>
    </div>
  </>;
}

export function ReportPrerequisites({ model }: { model: ReportPrerequisitesModel }) {
  return <section aria-labelledby="prerequisites-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
    <h2 id="prerequisites-heading" className="font-display text-lg font-semibold text-ink">Prerequisites and provenance</h2>
    <p className="mt-2 text-sm text-ink-muted">What this workflow export declares that may need credential, package, environment or linked-workflow setup.</p>
    {model.status === 'AVAILABLE' ? <Available model={model} /> : <div role="alert" className="mt-4 rounded-control border border-sev-high bg-raised p-3 text-sm text-sev-high">
      <p className="font-mono text-xs font-bold">{model.reason}</p>
      <p className="mt-1">Prerequisite observations are unavailable for this completed scan. This is not a clean prerequisite result.</p>
      <p className="mt-2 break-all font-mono text-2xs">Bound input SHA-256: {model.inputSha256}</p>
    </div>}
  </section>;
}
