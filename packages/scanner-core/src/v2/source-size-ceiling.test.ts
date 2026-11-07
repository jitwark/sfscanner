import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { scanWorkflowV2 } from './index';
import { admitCandidate, makeFact } from '../capabilities/adapter-evidence';
import { BETA_DEFAULT_PROFILE_MANIFEST, type ProfileManifestV2 } from '../capabilities/profile-manifest';
import {
  scheduleCapabilities,
  type AnalyzerContextV2,
  type CapabilityCandidateV2,
  type CapabilitySpecV2,
} from '../capabilities/scheduler';
import { createCapabilityCandidateAdmissionSnapshotV2 } from '../admission/snapshot';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';

/**
 * D-1 (2026-10-17). The scheduler used to hand each capability a bounded copy of the analyzer
 * context and then collapse any failure of that copy into `REQUIRED_CAPABILITY_FAILED`. The bound
 * was a constant of 8,192 copied objects against a documented `maxMembersAndElements` of 250,000,
 * so every workflow of roughly 2,500 source members failed as `INDETERMINATE` with a null
 * assessment, five opaque diagnostics, and every limit row reporting `exhausted: false`.
 *
 * These tests pin both halves of the repair: the bound is now derived from the documented limits
 * (so an admissible document is graded), and a capability that still cannot publish its result says
 * which kind of failure it hit.
 */

type Workflow = Readonly<{ nodes: readonly unknown[]; connections: Record<string, unknown> }>;

const scan = (workflow: Workflow) => scanWorkflowV2({
  bytes: new TextEncoder().encode(JSON.stringify(workflow)),
  profile: { id: 'beta-default', version: '2.0.0' },
});

const node = (index: number, parameters: Record<string, unknown> = {}, type = 'n8n-nodes-base.noOp'): Readonly<Record<string, unknown>> => ({
  parameters: { a: index, b: `v${index}`, c: index % 2 === 0, ...parameters },
  name: `Node ${index}`, type, typeVersion: 1, id: `id-${index}`, position: [index * 10, 0],
});

function chainNodes(nodes: readonly unknown[]): Workflow {
  const connections: Record<string, unknown> = {};
  for (let index = 1; index < nodes.length; index += 1) {
    connections[`Node ${index - 1}`] = { main: [[{ node: `Node ${index}`, type: 'main', index: 0 }]] };
  }
  return { nodes, connections };
}

const chain = (count: number, filler: number): Workflow => chainNodes(
  Array.from({ length: count }, (_, index) => node(index, { d: Array.from({ length: filler }, (_, value) => value) })),
);

const syntaxExamined = (workflow: Workflow): number => {
  const result = scan(workflow);
  if (!result.ok) throw new Error(`fixture must scan: ${result.code}`);
  return result.result.limits.usage.find((row) => row.id === 'maxSyntaxNodes')?.examined ?? -1;
};

const nested = (depth: number): Record<string, unknown> => {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) value = { a: value };
  return value;
};

const schedulerRegistry = (run: (id: string) => CapabilityCandidateV2): Map<string, CapabilitySpecV2> => new Map(
  BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, { ...capability, run: () => run(capability.id) }]),
);

const emptyCandidate = (): CapabilityCandidateV2 => createCapabilityCandidateAdmissionSnapshotV2({
  findings: [], diagnostics: [], facts: [], traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0,
});

// A candidate the validator refuses for a *limit*: `workflow.*` facts admit one per candidate, so a
// second one of the same kind exceeds the cap and the reason is `LIMIT_EXCEEDED`.
const limitRefusedCandidate = (): CapabilityCandidateV2 => admitCandidate({
  findings: [], diagnostics: [], traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0,
  facts: [
    makeFact('workflow.summary.v1', { kind: 'WORKFLOW' }, { connectionCount: 0 }),
    makeFact('workflow.summary.v1', { kind: 'WORKFLOW' }, { connectionCount: 1 }),
  ],
});

const smallParsed = parseSourceDocument(new TextEncoder().encode('{"nodes":[],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
if (!smallParsed.ok) throw new Error('fixture source must parse');
const smallNormalized = normalizeSecurityWorkflow(smallParsed.document, DEFAULT_SCANNER_LIMITS_V2);
if (!smallNormalized.ok) throw new Error('fixture workflow must normalize');
// The source-normalization path reads only these fields; the cast keeps the fixture free of the
// catalogue and target wiring the scheduler copies but no assertion here depends on.
const contextFixture = {
  source: smallParsed.document, workflow: smallNormalized.workflow,
  limits: DEFAULT_SCANNER_LIMITS_V2, rules: { rules: new Map() }, priorOutcomes: new Map(),
} as unknown as AnalyzerContextV2;

const hostileContext = (priorOutcomes: ReadonlyMap<string, unknown>): AnalyzerContextV2 => ({
  ...contextFixture, priorOutcomes,
}) as unknown as AnalyzerContextV2;

describe('D-1 source size and capacity refusals', () => {
  it('grades the members a workflow carries rather than refusing it at the old ceiling', () => {
    const small = scan(chain(10, 70));
    const bracketing = scan(chain(10, 72));
    expect(small.ok && bracketing.ok).toBe(true);
    if (!small.ok || !bracketing.ok) return;
    // Before the repair: `small` was COMPLETE and `bracketing` was INDETERMINATE with a null
    // assessment (1,939 and 1,979 members, against a documented ceiling of 250,000).
    expect({
      small: { status: small.result.analysis.status, grade: small.result.assessment?.grade },
      bracketing: { status: bracketing.result.analysis.status, grade: bracketing.result.assessment?.grade },
    }).toEqual({
      small: { status: 'COMPLETE', grade: 'LOW' },
      bracketing: { status: 'COMPLETE', grade: 'LOW' },
    });
    expect(syntaxExamined(chain(10, 72))).toBe(1_979);
  });

  it('grades a document two orders of magnitude past the old copied-object bound', () => {
    // 20,000 empty arrays: 40,041 syntax nodes over 20,014 members and elements, in 60 KB, well
    // inside every documented limit and far past the 8,192 objects the context copy used to allow
    // (about 2,000 of them). The pin is the engine's own reported usage, not a member count:
    // `limitUsage` fills the `maxSyntaxNodes` row from the parser's `syntaxNodeCount`, whose
    // rule (`source-tree-helpers.ts` `syntaxContribution`) is object = 1 + 2 × members, array = 1 +
    // elements, scalar = 1. Here the 20,000 empty arrays cost 20,000, the array holding them 20,001,
    // and every other container and scalar 40 — 40,041, reproduced twice (an independent walk of the
    // rule and `parseSourceDocument` itself); the previous pin of 40,035 was arithmetic that never
    // matched this fixture.
    const workflow = chainNodes([node(0, { a: Array.from({ length: 20_000 }, () => []) })]);
    const result = scan(workflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(result.result.analysis.diagnostics).toEqual([]);
    expect(result.result.assessment).not.toBeNull();
    expect(syntaxExamined(workflow)).toBe(40_041);
  }, 60_000);

  it('copies parameters nested past the old context depth bound', () => {
    const workflow = chainNodes([node(0, { nested: nested(60) })]);
    const result = scan(workflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The semantic mirror costs two context levels per document level, so a 60-level parameter
    // exceeds the old fixed depth bound of 64 while staying inside `maxParameterDepth = 64`.
    expect(result.result.analysis.status).toBe('COMPLETE');
  });

  it('keeps the assessment withheld when a required capability is genuinely incomplete', () => {
    // The finding-bearing node's name is refused by the safe-fact *content* rule (`safeText` in
    // `facts/safe-fact-validator.ts`), not by the label-format rule: its `PROSE` class refuses a
    // URL-shaped label, because evidence never republishes prose, prose-shaped payloads, or
    // pointers to external locations. Every character in this label is one a label is allowed to
    // carry, so the refusal can only come from the content rule; no decision about which visible
    // character classes are admissible labels can turn it into an admitted one.
    // `structural-policies` therefore cannot publish the subject that carries the name. The grade
    // must stay withheld: the repair must not turn an incomplete run into a graded one.
    //
    // (This fixture used an emoji name until D-2 made every visible character class an admissible
    // label, which turned that name into a legitimate label rather than an incompleteness.)
    const risky = chainNodes([{
      parameters: { command: 'echo hi' }, name: 'Run https://example.invalid/hook', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, id: 'risky', position: [0, 0],
    }]);
    const result = scan(risky);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('INDETERMINATE');
    expect(result.result.assessment).toBeNull();
    expect(result.result.analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIRED_CAPABILITY_FAILED', capabilityId: 'structural-policies', aggregateEffect: 'INDETERMINATE' }),
    ]));
    expect(result.result.analysis.capabilities.find(({ id }) => id === 'structural-policies')?.status).toBe('FAILED');
  });

  it('publishes a candidate refused by a limit as a limit diagnostic', () => {
    const result = scheduleCapabilities(
      contextFixture, BETA_DEFAULT_PROFILE_MANIFEST,
      schedulerRegistry((id) => (id === 'source-normalization' ? limitRefusedCandidate() : emptyCandidate())),
    );
    // Before the repair this diagnostic was `REQUIRED_CAPABILITY_FAILED`: the validator's
    // `LIMIT_EXCEEDED` reason reached the scheduler and was dropped on the floor.
    expect(result.diagnostics).toHaveLength(5);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization',
      aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    expect(result.executions[0]).toMatchObject({ id: 'source-normalization', status: 'FAILED', omitted: 1 });
  });

  it('names the bound a refused context view exceeded', () => {
    // A map no admissible context carries is still refused, and the refusal now carries the size
    // that fired and the bound it fired against instead of an opaque capability failure.
    const oversized = new Map<string, unknown>();
    for (let index = 0; index < 4_097; index += 1) oversized.set(`prior-${index}`, emptyCandidate());
    const result = scheduleCapabilities(hostileContext(oversized), BETA_DEFAULT_PROFILE_MANIFEST, schedulerRegistry(() => emptyCandidate()));
    expect(result.diagnostics[0]).toMatchObject({
      code: 'REQUIRED_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization',
      observed: 4_097, maximum: 4_096,
    });
    expect(result.executions[0]).toMatchObject({ id: 'source-normalization', status: 'FAILED', omitted: 1 });
  });

  it('leaves a runner that throws without a bound on the generic capability failure', () => {
    const registry = schedulerRegistry(() => emptyCandidate());
    registry.set('source-normalization', { ...registry.get('source-normalization')!, run: () => { throw new Error('capability exploded'); } });
    const result = scheduleCapabilities(contextFixture, BETA_DEFAULT_PROFILE_MANIFEST, registry);
    expect(result.diagnostics[0]).toMatchObject({ code: 'REQUIRED_CAPABILITY_FAILED', capabilityId: 'source-normalization' });
    expect(result.diagnostics[0]).not.toHaveProperty('observed');
    expect(result.diagnostics[0]).not.toHaveProperty('maximum');
  });
});

export type { ProfileManifestV2 };
