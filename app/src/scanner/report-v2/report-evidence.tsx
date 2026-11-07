import type { SourceMemberRefV2, SubjectV2 } from '@hub/contracts/scanner-v2-source';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { safeReportText } from '../report/report-safe-content';
import { isAdvisoryFactKindV1 } from '@hub/contracts/scanner-v2-advisory';
import { AdvisoryFactDetails } from './report-advisory';

type ReportEvidenceProps = { model: ScannerReportModelV2 };

/**
 * A closed, per-kind field allowlist. A validated fact can only carry these scalar or scalar-list
 * properties, and only the fields registered here are ever read; an unregistered kind renders its
 * label alone rather than risking a raw property dump.
 */
const FACT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'workflow.summary.v1': ['connectionCount'],
  'workflow.structure.v1': ['total', 'executable', 'disabled', 'inert', 'unresolved', 'vertices', 'edges', 'unresolvedEdges', 'parallelEdgeCount', 'weakComponents', 'structuralCycleRank'],
  'workflow.dependencies.v1': ['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'credentialReferences', 'requiredCredentialSlots', 'configuredCredentialSlots', 'missingCredentialSlots', 'unknownCredentialSlots', 'environmentReferences', 'redactedIdentifiers', 'omittedIdentifiers'],
  'workflow.effects.v1': ['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'effectCounts', 'disabledEffectNodes'],
  'workflow.function.v1': ['basicPurpose', 'triggerDescription', 'dataFlowSummary', 'businessCategory', 'confidence'],
  'workflow.risk-summary.v1': ['topRisks', 'dataExposure', 'complexityDrivers'],
  'workflow.fingerprint.v1': ['value'],
  'integration.v1': ['service', 'usage', 'nodeTypes', 'nodeCount', 'riskNotes'],
  'node.capability.v2': ['nodeType', 'nodePackage', 'namespaceClass', 'capabilities', 'toolCount', 'contextCount'],
  'node.configuration.v2': ['observation', 'header', 'literalValue', 'parameterPath', 'secretKind', 'indicator', 'hasLiteralValue'],
  'code.indicator.v2': ['language', 'indicator', 'member', 'start', 'end', 'parseState'],
  'dataflow.summary.v2': ['flowKind', 'sink', 'parameterPath', 'referenceRoot', 'propertyPath', 'sourceNodeId', 'sourceNodeName', 'propertyPathComplete', 'humanGatePresent', 'humanGateDominates', 'taintLabels'],
  'destination.v2': ['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode'],
  'destination.v3': ['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode', 'reason', 'omitted', 'inventoryStatus'],
  'destination.coverage.v1': ['inventoryStatus', 'nodesExamined', 'pathsConfigured', 'recordsEmitted', 'errors', 'omitted', 'errorCodes'],
  'ingress.v2': ['authentication', 'authenticationState', 'legacyAuthenticated'],
};

const UNKNOWN_KIND_NOTE = 'Properties are not displayed for an unregistered fact kind.';
const NO_FIELDS_NOTE = 'No allowlisted fact properties were retained for this fact.';

export function sourceForSubject(subject: SubjectV2): SourceMemberRefV2 | undefined {
  if (subject.kind === 'SOURCE') return subject.source;
  if (subject.kind === 'NODE') return subject.node.source;
  if (subject.kind === 'EDGE') return subject.edge.source;
  return undefined;
}

export function sourceSpanLabel(subject: SubjectV2 | undefined): string {
  const span = subject === undefined ? undefined : sourceForSubject(subject)?.span;
  if (span === undefined || span === null) return 'Source span unavailable (redacted or not retained).';
  return `Source span: line ${span.start.line}, column ${span.start.column} to line ${span.end.line}, column ${span.end.column}`;
}

/** Renders only a scalar or a scalar list; any other shape is withheld instead of stringified. */
function displayFactValue(value: unknown): string {
  if (value === null) return 'Not present';
  if (typeof value === 'string') return safeReportText(value, 200);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.map(displayFactValue).join(', ');
  return 'Structured details withheld';
}

function emptyFactsMessage(model: ScannerReportModelV2): string {
  const { analysis } = model.v2;
  if (analysis.status === 'COMPLETE') return 'No additional facts observed in this result.';
  const reasons = [
    ...analysis.capabilities
      .filter((capability) => capability.status !== 'COMPLETED')
      .map((capability) => `${safeReportText(capability.id, 100)} (${safeReportText(capability.status, 40)})`),
    ...analysis.diagnostics.map((diagnostic) => safeReportText(diagnostic.code, 100)),
  ];
  const unique = [...new Set(reasons)];
  const shown = unique.slice(0, 6);
  const more = unique.length - shown.length;
  const reasonText = unique.length === 0 ? '' : ` Reasons: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
  return `Canonical facts are unavailable for this incomplete check (analysis status: ${safeReportText(analysis.status, 40)}). This result is not clean.${reasonText}`;
}

export function ReportEvidence({ model }: ReportEvidenceProps) {
  const { analysis, findings, facts } = model.v2;
  const factsById = new Map(facts.map((fact) => [fact.factId, fact]));

  return (
    <section aria-labelledby="scanner-v2-evidence-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 id="scanner-v2-evidence-heading" className="font-display text-lg font-semibold text-ink">Evidence and conclusions</h2>
      <p className="mt-1 text-sm leading-6 text-ink-muted">These metadata-only records explain what the scanner observed. Raw workflow values and source payloads are withheld.</p>

      <div className="mt-4">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Canonical facts</h3>
        {facts.length === 0 ? <p className="mt-3 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted" role="note">{emptyFactsMessage(model)}</p> : <ul aria-label="Canonical facts" className="mt-3 space-y-2">
          {facts.map((fact) => {
            const allowlist = Object.prototype.hasOwnProperty.call(FACT_FIELDS, fact.kind) ? FACT_FIELDS[fact.kind] : undefined;
            const fields = (allowlist ?? []).flatMap((key) => Object.prototype.hasOwnProperty.call(fact.properties, key)
              ? [[key, displayFactValue(fact.properties[key])] as const]
              : []);
            return <li key={fact.factId} className="rounded-control border border-hairline bg-raised/40 p-3">
              <p className="font-mono text-xs font-semibold text-ink">{safeReportText(fact.kind, 100)}</p>
              {isAdvisoryFactKindV1(fact.kind) ? <AdvisoryFactDetails fact={fact} /> : allowlist === undefined ? <p className="mt-2 text-sm text-ink-muted">{UNKNOWN_KIND_NOTE}</p> : <>
                <p className="mt-1 text-xs leading-5 text-ink-muted">{fact.subject.kind === 'WORKFLOW' ? 'Workflow-wide fact.' : sourceSpanLabel(fact.subject)}</p>
                {fields.length === 0 ? <p className="mt-2 text-sm text-ink-muted">{NO_FIELDS_NOTE}</p> : <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                  {fields.map(([key, value]) => <div key={key}>
                    <dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">{key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (letter) => letter.toUpperCase())}</dt>
                    <dd className="mt-0.5 text-ink">{value}</dd>
                  </div>)}
                </dl>}
              </>}
            </li>;
          })}
        </ul>}
      </div>

      {findings.length > 0 ? <div className="mt-4 divide-y divide-hairline border-t border-hairline pt-4">
        {findings.map((finding) => {
          const referencedFacts = finding.factRefs.map((ref) => factsById.get(ref)).filter((fact): fact is typeof facts[number] => fact !== undefined);
          const subject = finding.subject.kind === 'WORKFLOW' && referencedFacts.length > 0 ? referencedFacts[0]?.subject : finding.subject;
          return <article key={finding.findingId} className="py-4 first:pt-0 last:pb-0">
            <h3 className="font-display text-base font-semibold text-ink">{safeReportText(finding.ruleId, 140)}</h3>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">Evidence class</dt><dd className="mt-1 text-ink">Evidence class: {safeReportText(finding.evidenceClass, 80)}</dd></div>
              <div><dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">Conclusion</dt><dd className="mt-1 text-ink">Conclusion: {safeReportText(finding.conclusion, 80)}</dd></div>
              <div className="sm:col-span-2"><dt className="font-mono text-2xs uppercase tracking-wider text-ink-muted">Source location</dt><dd className="mt-1 text-ink">{sourceSpanLabel(subject)}</dd></div>
            </dl>
            <p className="mt-3 text-xs leading-5 text-ink-muted">Safe evidence: {referencedFacts.length > 0 ? referencedFacts.map((fact) => safeReportText(fact.kind, 120)).join(', ') : 'No registered fact reference.'}. Allowlisted fact fields are listed under Canonical facts.</p>
          </article>;
        })}
      </div> : facts.length > 0 ? <p className="mt-4 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted" role="note">No findings were returned for this result.</p> : null}
    </section>
  );
}
