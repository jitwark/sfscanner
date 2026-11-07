import { describe, expect, it } from 'vitest';
import { validateTargetContextV3 } from '../semantics/target-context';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BETA_DEFAULT_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { parseSourceDocument } from '../source/source-parser';
import type { SourceValueV2 } from '../source/source-types';
import { classifyBudgetOutcome } from '../workflow-v2/budget-outcomes';
import { composeScannerResultV2, type ComposeScannerResultV2Input } from '../result-v2/compose-result';
import { createDiagnostic } from '../capabilities/adapter-evidence';
import { projectResultV2ToV1 } from '../compat/v1-projector';
import { spanLossIsSecurityRequired } from './span-loss-classification';
import { scanWorkflowV2 } from './scan-workflow';

const encoder = new TextEncoder();
const PROFILE = { id: 'beta-default', version: '2.0.0' };
const SOURCE = '{"nodes":[{"id":"start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{"note":"x"}}],"connections":{}}';
const OPTIONAL = 'OPTIONAL_LIMIT_EXCEEDED';
const REQUIRED = 'REQUIRED_LIMIT_EXCEEDED';

/**
 * The span accounting read back from the parsed document itself, which is what the run's
 * `examined`/`omitted` numbers have to describe. Walking the frozen tree is an independent
 * path from the parser's internal retention decision, so the two agreeing is evidence.
 */
function spanCounts(maxStoredSourceSpans: number): { examined: number; stored: number } {
  const parsed = parseSourceDocument(encoder.encode(SOURCE), { maxStoredSourceSpans });
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.message}`);
  const pending: SourceValueV2[] = [parsed.document.root];
  let examined = 0;
  let stored = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) continue;
    examined += 1;
    if (value.ref.span !== null) stored += 1;
    if (value.kind === 'ARRAY') pending.push(...value.items);
    else if (value.kind === 'OBJECT') for (const member of value.members) pending.push(member.value);
  }
  return { examined, stored };
}

const reality = spanCounts(DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans);

function scan(maxStoredSourceSpans: number) {
  const result = scanWorkflowV2({ bytes: encoder.encode(SOURCE), profile: PROFILE, limits: { maxStoredSourceSpans } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.result;
}

describe('v2 stored source span accounting', () => {
  it('reports the spans it dropped and degrades instead of claiming completeness', () => {
    expect(reality.examined).toBeGreaterThan(1);
    expect(spanCounts(1).stored).toBe(1);

    const result = scan(1);
    expect(result.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans')).toEqual({
      id: 'maxStoredSourceSpans', maximum: 1, examined: reality.examined, omitted: reality.examined - 1, exhausted: true,
    });

    expect(result.analysis.diagnostics.map(({ code }) => code)).toEqual([OPTIONAL]);
    const diagnostic = result.analysis.diagnostics[0];
    expect(diagnostic).toMatchObject({ category: 'LIMIT', capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED', assessmentEligible: true });
    expect(result.analysis.capabilities.find(({ id }) => id === 'source-normalization')?.diagnosticIds).toContain(diagnostic?.id);
    expect(result.analysis.status).toBe('DEGRADED');
    // A presentation-only loss is a degraded result, not an unusable one: the assessment stays.
    expect(result.assessment).not.toBeNull();
    // The record and the budget registry have to agree; either drifting fails here.
    expect(classifyBudgetOutcome({ budget: 'maxStoredSourceSpans', securityRequired: spanLossIsSecurityRequired(BETA_DEFAULT_PROFILE_MANIFEST) }))
      .toMatchObject({ kind: 'DIAGNOSTIC', code: OPTIONAL, aggregateEffect: diagnostic?.aggregateEffect, assessmentEligible: diagnostic?.assessmentEligible });
  });

  it('leaves a fixture at or under the span limit complete and unaccounted', () => {
    for (const maximum of [reality.examined, DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans]) {
      const result = scan(maximum);
      expect(result.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans'))
        .toEqual({ id: 'maxStoredSourceSpans', maximum, examined: reality.examined, omitted: 0, exhausted: false });
      expect(result.analysis.diagnostics).toEqual([]);
      expect(result.analysis.status).toBe('COMPLETE');
    }
  });

  it('classifies every reachable truncation on the admitted path as a presentation-only loss', () => {
    // The admitted profile states no classification through trace steps, so no omission of stored
    // spans can take an identity or a classification with it: the class stays OPTIONAL however much
    // of the span budget is spent.
    expect(spanLossIsSecurityRequired(BETA_DEFAULT_PROFILE_MANIFEST)).toBe(false);
    for (const maximum of [0, 1, reality.examined - 1]) {
      const result = scan(maximum);
      expect(result.analysis.diagnostics.map(({ code }) => code)).toEqual([OPTIONAL]);
      expect(result.analysis.status).toBe('DEGRADED');
      expect(result.assessment).not.toBeNull();
      expect(result.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans')).toEqual({
        id: 'maxStoredSourceSpans', maximum, examined: reality.examined, omitted: reality.examined - Math.min(maximum, reality.examined), exhausted: true,
      });
    }
  });

  it('keeps the v1 span-loss signal through the projector, not the v2 record', () => {
    // The blanket SOURCE_SPAN_UNAVAILABLE record is gone, and dropping it loses nothing for a v1
    // consumer: the projector emits that code from the location a projected finding actually lost.
    const source = '{"nodes":[{"id":"cmd","name":"Run","type":"n8n-nodes-base.executeCommand","typeVersion":1,"parameters":{"command":"echo hi"}}],"connections":{}}';
    const result = scanWorkflowV2({ bytes: encoder.encode(source), profile: PROFILE, limits: { maxStoredSourceSpans: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const subject = result.result.findings[0]?.subject;
    expect(result.result.findings.map(({ ruleId }) => ruleId)).toEqual(['N8N_EXECUTE_COMMAND']);
    expect(subject?.kind === 'NODE' && subject.node.source.span).toBeNull();
    expect(result.result.analysis.diagnostics.map(({ code }) => code)).toEqual([OPTIONAL]);

    const projected = projectResultV2ToV1(result.result);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.result.analysisDiagnostics.map(({ code }) => code)).toContain('SOURCE_SPAN_UNAVAILABLE');
  });

  it('withholds the assessment when an omitted span carries a security classification', () => {
    // REQUIRED belongs to a profile whose classification is stated through trace steps: a trace step
    // cannot resolve a span-less subject, and the trace builder answers that with an UNKNOWN trace.
    // The admitted path is not such a profile; this one is, and the class follows the profile.
    expect(spanLossIsSecurityRequired(BETA_HARDENED_PROFILE_MANIFEST)).toBe(true);
    expect(classifyBudgetOutcome({ budget: 'maxStoredSourceSpans', securityRequired: true })).toMatchObject({
      kind: 'DIAGNOSTIC', code: REQUIRED, aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });

    const diagnostic = createDiagnostic(REQUIRED, 'source-normalization', true);
    expect(diagnostic).toMatchObject({ category: 'LIMIT', aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    const composed = composeScannerResultV2({
      ...composableView(),
      analysis: {
        status: 'COMPLETE',
        capabilities: [{ id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED', seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [diagnostic.id] }],
        diagnostics: [diagnostic],
      },
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.result.analysis.status).toBe('INDETERMINATE');
    expect(composed.result.assessment).toBeNull();
  });
});

const digest = (letter: string): string => letter.repeat(64);

/** A minimal result the composer accepts, so the REQUIRED class is proven against the real composer. */
function composableView(): ComposeScannerResultV2Input {
  return {
    engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
    input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
    profile: { id: 'beta-default', version: '2.0.0' },
    ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
    semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
    target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }),
    limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
    analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
    workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
    facts: [], traces: [], findings: [],
    assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  };
}
