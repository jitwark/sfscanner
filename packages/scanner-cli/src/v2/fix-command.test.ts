import { describe, expect, it } from 'vitest';
import {
  createFixSuggestion,
  type FixPlanV1,
  type FixPrerequisiteEvidenceV1,
  type FixSuggestionFactV1,
} from '@hub/scanner-core/remediation/fix-suggestion';
import { parseSourceDocument } from '@hub/scanner-core/source/source-parser';
import { normalizeSecurityWorkflow } from '@hub/scanner-core/workflow-v2/normalize-security-workflow';
import type { CliFixCommandV2 } from './arguments';
import type { ConditionalReplaceHostV1, FixApplyRequestV1, FixApplyResultV1 } from './fix-apply';
import type { InputReadHost } from './input-read';
import type { FixPlanHostV1, FixPlanRequestV1, FixPlanRunResultV1 } from './fix-plan';
import { runFixCommandV2 } from './fix-command';

const WORKFLOW = `{
  "name": "demo",
  "nodes": [
    {
      "id": "n1",
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": { "url": "http://insecure.example.com", "method": "GET" }
    }
  ],
  "connections": {}
}`;

const SOURCE = new TextEncoder().encode(WORKFLOW);
const ROOT = 'D:/fix-command';
const INPUT = 'workflow.json';
const SHA = 'a'.repeat(64);
const RESULT_SHA = 'b'.repeat(64);
const RESULT = new TextEncoder().encode('{}\n');

type Fixture = Readonly<{ sourceSha256: string; workflowDigest: string; nodeDigest: string; pointer: string }>;

function analyze(): Fixture {
  const parsed = parseSourceDocument(SOURCE);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.code}`);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  if (!normalized.ok) throw new Error(`fixture normalize failed: ${normalized.code}`);
  const node = normalized.workflow.nodes[0];
  if (!node) throw new Error('fixture node missing');
  return {
    sourceSha256: parsed.document.rawSha256,
    workflowDigest: normalized.semanticSha256,
    nodeDigest: node.ref.identityDigest,
    pointer: `${node.ref.source.pointer}/parameters/url`,
  };
}

const fixture = analyze();

function suggestion(overrides: Record<string, unknown> = {}): FixSuggestionFactV1 {
  const created = createFixSuggestion({
    id: 'fix-1',
    findingIds: ['finding-1'],
    sourceSha256: fixture.sourceSha256,
    workflowDigest: fixture.workflowDigest,
    targetVersion: { packageName: 'n8n-nodes-base.httpRequest', version: '4.2.0', inventoryDigest: SHA },
    resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.nodeDigest, pointer: fixture.pointer },
    templateId: 'REMOVE_INSECURE_OVERRIDE',
    rationaleId: 'REMOVE_INSECURE_OVERRIDE',
    prerequisites: ['USER_CONFIRMATION'],
    ...overrides,
  });
  if (!created.ok) throw new Error(`fixture suggestion refused: ${created.reason}`);
  return created.suggestion;
}

const CONFIRMATION: FixPrerequisiteEvidenceV1 = Object.freeze({ code: 'USER_CONFIRMATION', evidenceDigest: fixture.sourceSha256 });

const READY: FixPlanV1 = Object.freeze({
  status: 'READY',
  suggestionId: 'fix-1',
  sourceSha256: fixture.sourceSha256,
  resultSha256: RESULT_SHA,
  patch: Object.freeze([Object.freeze({ op: 'remove' as const, path: fixture.pointer })]),
});
const REFUSED: FixPlanV1 = Object.freeze({ status: 'REFUSED', reason: 'STALE_SOURCE' });
const WRITTEN: FixApplyResultV1 = Object.freeze({
  status: 'WRITTEN',
  sourceSha256: fixture.sourceSha256,
  resultSha256: RESULT_SHA,
  backupSha256: fixture.sourceSha256,
});

const HOST: ConditionalReplaceHostV1 = Object.freeze({ replaceIfUnchanged: async () => 'REPLACED' as const });
const PLAN_HOST: FixPlanHostV1 = Object.freeze({ inputRead: { readFile: async () => SOURCE } satisfies InputReadHost });

function suggest(overrides: Partial<CliFixCommandV2> = {}): CliFixCommandV2 {
  return Object.freeze({
    kind: 'fix', schema: 'v2', action: 'suggest', format: 'json', root: ROOT, input: INPUT, fix: 'fix-1', confirm: false, ...overrides,
  });
}

function apply(overrides: Partial<CliFixCommandV2> = {}): CliFixCommandV2 {
  return suggest({ action: 'apply', confirm: true, ...overrides });
}

function planStub(response: FixPlanRunResultV1 | (() => Promise<FixPlanRunResultV1>)): Readonly<{
  calls: FixPlanRequestV1[];
  hostCalls: (FixPlanHostV1 | undefined)[];
  fn: (request: FixPlanRequestV1, host?: FixPlanHostV1) => Promise<FixPlanRunResultV1>;
}> {
  const calls: FixPlanRequestV1[] = [];
  const hostCalls: (FixPlanHostV1 | undefined)[] = [];
  return {
    calls,
    hostCalls,
    fn: async (request, host) => {
      calls.push(request);
      hostCalls.push(host);
      return typeof response === 'function' ? await response() : response;
    },
  };
}

function applyStub(result: FixApplyResultV1): Readonly<{
  calls: FixApplyRequestV1[];
  fn: (request: FixApplyRequestV1) => Promise<FixApplyResultV1>;
}> {
  const calls: FixApplyRequestV1[] = [];
  return {
    calls,
    fn: async (request) => {
      calls.push(request);
      return result;
    },
  };
}

function readyPlan(): FixPlanRunResultV1 {
  const selected = suggestion();
  return Object.freeze({ ok: true, plan: READY, suggestion: selected, prerequisites: Object.freeze([CONFIRMATION]) });
}

describe('runFixCommandV2 suggest', () => {
  it('dispatches the selected suggestion to the planner and never to apply', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(suggest({ mapping: 'mapping.json', endpointReceipt: 'endpoint.json' }), {}, {
      suggestions: Object.freeze([suggestion()]),
      plan: plan.fn,
      apply: applied.fn,
    });

    expect(result.exitCode).toBe(0);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({
      root: ROOT,
      input: INPUT,
      mapping: 'mapping.json',
      endpointReceipt: 'endpoint.json',
      suggestion: expect.objectContaining({ id: 'fix-1' }),
    });
    expect(applied.calls).toHaveLength(0);
    expect(result.document).toMatchObject({ schemaVersion: 'n8n-scan-fix-v2', action: 'suggest', status: 'READY', plan: READY });
    expect(JSON.parse(result.stdout)).toEqual(result.document);
    expect(result.stderr).toBe('');
  });

  it('plans a refusal through the real planner while keeping the suggestion available', async () => {
    const result = await runFixCommandV2(suggest({ confirm: false }), { planHost: PLAN_HOST }, {
      suggestions: Object.freeze([suggestion()]),
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({
      status: 'REFUSED',
      suggestion: expect.objectContaining({ id: 'fix-1' }),
      plan: { status: 'REFUSED', reason: 'MISSING_PREREQUISITE' },
    });
  });

  it('plans a ready suggestion through the real planner when confirmation evidence is supplied', async () => {
    const result = await runFixCommandV2(suggest(), { planHost: PLAN_HOST }, {
      suggestions: Object.freeze([suggestion()]),
      evidence: Object.freeze([CONFIRMATION]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.document).toMatchObject({ status: 'READY', plan: { status: 'READY', suggestionId: 'fix-1' } });
  });

  it('fails with a typed refusal when the selected fix is not available', async () => {
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2(suggest({ fix: 'fix-2' }), {}, { suggestions: Object.freeze([suggestion()]), plan: plan.fn });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'NO_SUGGESTION' });
    expect(plan.calls).toHaveLength(0);
  });

  it('fails with a typed refusal when no suggestion catalogue is supplied', async () => {
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2(suggest(), {}, { plan: plan.fn });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'NO_SUGGESTION' });
    expect(plan.calls).toHaveLength(0);
  });
});

describe('runFixCommandV2 apply', () => {
  it('does not apply when the plan is refused', async () => {
    const plan = planStub(Object.freeze({ ok: true, plan: REFUSED, prerequisites: Object.freeze([]) }));
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), { applyHost: { conditionalReplace: HOST }, result: RESULT }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({ status: 'REFUSED', plan: REFUSED });
    expect(applied.calls).toHaveLength(0);
  });

  it('keeps a missing prerequisite receipt typed and never reaches apply', async () => {
    const plan = planStub(Object.freeze({ ok: false, code: 'MISSING_OR_INVALID_CREDENTIAL_MAPPING' as const, message: 'Mapping required.' }));
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply({ mapping: 'mapping.json' }), { applyHost: { conditionalReplace: HOST }, result: RESULT }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({
      status: 'FAILED',
      code: 'MISSING_OR_INVALID_CREDENTIAL_MAPPING',
      suggestion: expect.objectContaining({ id: 'fix-1' }),
    });
    expect(applied.calls).toHaveLength(0);
  });

  it('refuses an unproven host before the apply adapter and keeps the plan available', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), {}, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({
      status: 'HOST_UNSUPPORTED',
      reason: 'NO_CONDITIONAL_REPLACE',
      suggestion: expect.objectContaining({ id: 'fix-1' }),
      plan: READY,
    });
    expect(result.document).not.toHaveProperty('apply');
    expect(applied.calls).toHaveLength(0);
  });

  it('plans then applies once a conditional replace host is proven', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), { applyHost: { conditionalReplace: HOST }, result: RESULT }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(0);
    expect(plan.calls).toHaveLength(1);
    expect(applied.calls).toHaveLength(1);
    expect(applied.calls[0]).toMatchObject({ plan: READY, root: ROOT, target: `${ROOT}/${INPUT}`, result: RESULT });
    expect(result.document).toMatchObject({ status: 'WRITTEN', apply: WRITTEN });
  });

  it('needs the planned result bytes before dispatching a proven host', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), { applyHost: { conditionalReplace: HOST } }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(2);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'USAGE' });
    expect(applied.calls).toHaveLength(0);
  });

  it('passes an apply cancellation through as 130', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(Object.freeze({ status: 'CANCELLED', reason: 'CANCELLED' }));
    const result = await runFixCommandV2(apply(), { applyHost: { conditionalReplace: HOST }, result: RESULT }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(130);
    expect(result.document).toMatchObject({ status: 'CANCELLED', apply: { reason: 'CANCELLED' } });
  });
});

describe('runFixCommandV2 suggestion provider', () => {
  it('awaits the provider before selecting the exact requested fix', async () => {
    const second = suggestion({ id: 'fix-2' });
    const commands: CliFixCommandV2[] = [];
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2(suggest({ fix: 'fix-2' }), {}, {
      suggestions: async (command) => {
        commands.push(command);
        return Object.freeze([suggestion(), second]);
      },
      plan: plan.fn,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'fix', action: 'suggest', input: INPUT });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.suggestion).toEqual(second);
    expect(plan.calls[0]?.evidence).toEqual([]);
    expect(result.document).toMatchObject({ status: 'READY', suggestionId: 'fix-2' });
    expect(result.document?.suggestion).toEqual(second);
  });

  it('cancels when the provider resolves after abort without planning', async () => {
    const controller = new AbortController();
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2(suggest(), { signal: controller.signal }, {
      suggestions: async () => {
        controller.abort();
        return Object.freeze([suggestion()]);
      },
      plan: plan.fn,
    });

    expect(result.exitCode).toBe(130);
    expect(result.document).toMatchObject({ status: 'CANCELLED' });
    expect(plan.calls).toHaveLength(0);
  });

  it('reports a provider rejection as a typed service failure without planning or applying', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(suggest(), {}, {
      suggestions: async () => {
        throw new Error('provider exploded');
      },
      plan: plan.fn,
      apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'SERVICE_FAILURE' });
    expect(plan.calls).toHaveLength(0);
    expect(applied.calls).toHaveLength(0);
  });

  it('plans a confirmed apply READY and stops at HOST_UNSUPPORTED without any write', async () => {
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), { planHost: PLAN_HOST }, {
      suggestions: async () => Object.freeze([suggestion()]),
      apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({
      status: 'HOST_UNSUPPORTED',
      reason: 'NO_CONDITIONAL_REPLACE',
      suggestionId: 'fix-1',
      plan: { status: 'READY', suggestionId: 'fix-1' },
    });
    expect(result.document).not.toHaveProperty('apply');
    expect(applied.calls).toHaveLength(0);
  });

  it('records USER_CONFIRMATION for an explicit apply and stops at HOST_UNSUPPORTED before any write', async () => {
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), {}, {
      suggestions: async () => Object.freeze([suggestion()]),
      plan: plan.fn,
      apply: applied.fn,
    });

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.evidence).toEqual([CONFIRMATION]);
    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({
      status: 'HOST_UNSUPPORTED',
      reason: 'NO_CONDITIONAL_REPLACE',
      suggestionId: 'fix-1',
    });
    expect(result.document).not.toHaveProperty('apply');
    expect(applied.calls).toHaveLength(0);
  });
});

describe('runFixCommandV2 failures', () => {
  it('rejects an unknown request union with typed usage and no adapter calls', async () => {
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2({ kind: 'scan' } as unknown as CliFixCommandV2, {}, { plan: plan.fn });

    expect(result.exitCode).toBe(2);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'USAGE' });
    expect(plan.calls).toHaveLength(0);
  });

  it('treats an unconfirmed apply as typed usage before planning', async () => {
    const plan = planStub(readyPlan());
    const result = await runFixCommandV2(apply({ confirm: false }), {}, { suggestions: Object.freeze([suggestion()]), plan: plan.fn });

    expect(result.exitCode).toBe(2);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'USAGE' });
    expect(plan.calls).toHaveLength(0);
  });

  it('reports a planner rejection as a typed service failure without retrying', async () => {
    const plan = planStub(async () => { throw new Error('planner exploded'); });
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(suggest(), {}, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(3);
    expect(result.document).toMatchObject({ status: 'FAILED', code: 'SERVICE_FAILURE' });
    expect(plan.calls).toHaveLength(1);
    expect(applied.calls).toHaveLength(0);
  });

  it('cancels before dispatch and calls no adapter', async () => {
    const controller = new AbortController();
    controller.abort();
    const plan = planStub(readyPlan());
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(suggest(), { signal: controller.signal }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(130);
    expect(result.document).toMatchObject({ status: 'CANCELLED', reason: 'CANCELLED' });
    expect(plan.calls).toHaveLength(0);
    expect(applied.calls).toHaveLength(0);
  });

  it('cancels after planning without apply', async () => {
    const controller = new AbortController();
    const plan = planStub(async () => {
      controller.abort();
      return readyPlan();
    });
    const applied = applyStub(WRITTEN);
    const result = await runFixCommandV2(apply(), { signal: controller.signal, applyHost: { conditionalReplace: HOST }, result: RESULT }, {
      suggestions: Object.freeze([suggestion()]), plan: plan.fn, apply: applied.fn,
    });

    expect(result.exitCode).toBe(130);
    expect(result.document).toMatchObject({ status: 'CANCELLED' });
    expect(applied.calls).toHaveLength(0);
  });
});
