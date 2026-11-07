import { describe, expect, it } from 'vitest';
import { proveApprovalV2, type ApprovalEventV2, type ApprovalPathV2, type ApprovalProofInputV2 } from './approval-proof';

const target = { tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'] } as const;
const approved = (overrides: Partial<ApprovalEventV2> = {}): ApprovalPathV2 => ({
  pathId: 'main',
  target,
  events: [{ kind: 'APPROVAL', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'], ...overrides }],
});
const run = (paths: readonly ApprovalPathV2[], extra: Partial<ApprovalProofInputV2> = {}) => proveApprovalV2({ target, paths, ...extra });

describe('agentic approval proof', () => {
  it('requires the actual tool, effect, and all material arguments', () => {
    expect(run([approved()])).toMatchObject({ status: 'APPROVED', assessmentEligible: true });
    expect(run([approved({ tool: 'command' })])).toMatchObject({ status: 'UNAPPROVED' });
    expect(run([approved({ argumentPaths: ['/to'] })])).toMatchObject({ status: 'UNAPPROVED' });
  });

  it.each([
    ['bypass', { events: [] }, 'UNAPPROVED'],
    ['reject', { events: [{ kind: 'REJECT', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'] }] }, 'UNAPPROVED'],
    ['timeout', { events: [{ kind: 'TIMEOUT', tool: 'mailer', effect: 'SEND_MESSAGE' }] }, 'UNKNOWN'],
    ['retry', { events: [{ kind: 'RETRY', tool: 'mailer', effect: 'SEND_MESSAGE' }] }, 'UNKNOWN'],
    ['error', { events: [{ kind: 'ERROR', tool: 'mailer', effect: 'SEND_MESSAGE' }] }, 'UNKNOWN'],
  ] as const)('does not credit %s as approval', (_name, path, status) => {
    expect(run([{ pathId: 'main', target, ...path }])).toMatchObject({ status });
  });

  it('requires every branch to carry a matching approval', () => {
    const bypass = { pathId: 'bypass', target, events: [] };
    expect(run([approved(), bypass])).toMatchObject({ status: 'UNAPPROVED', pathResults: [{ status: 'APPROVED' }, { status: 'UNAPPROVED' }] });
  });

  it('preserves non-zero ports and returns deterministic control evidence', () => {
    const input = { target: { ...target, port: 2 }, paths: [{ pathId: 'p', target: { ...target, port: 2 }, events: [{ kind: 'APPROVAL', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'], port: 2 }] }] } as ApprovalProofInputV2;
    const first = proveApprovalV2(input);
    expect(first).toEqual(proveApprovalV2(structuredClone(input)));
    expect(first.controlEvidence[0]).toMatchObject({ port: 2, targetPort: 2 });
  });

  it('abstains for omitted required evidence and explains report-only behavior', () => {
    expect(run([approved({ argumentPaths: undefined })])).toMatchObject({ status: 'UNKNOWN', aggregateEffect: 'INDETERMINATE', assessment: null });
    expect(run([approved({ argumentPaths: undefined })], { ruleEffect: 'REPORT_ONLY' })).toMatchObject({ status: 'UNKNOWN', aggregateEffect: 'DEGRADED', assessmentEligible: false, assessment: null, reportOnly: true });
  });

  it('returns a bounded result without a partial proof', () => {
    const result = run([approved()], { maxOperations: 0 });
    expect(result).toMatchObject({ status: 'LIMIT_EXCEEDED', omitted: 1, assessment: null });
    expect(result.pathResults).toEqual([]);
  });
  it('treats bypass as terminal and charges an empty control path', () => {
    const input: ApprovalProofInputV2 = { target, paths: [{ pathId: 'p', target, events: [{ kind: 'BYPASS' }, { kind: 'APPROVAL', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'] }] }] };
    expect(proveApprovalV2(input)).toMatchObject({ status: 'UNAPPROVED', pathResults: [{ reason: 'BYPASS' }] });
    expect(proveApprovalV2({ target, paths: [{ pathId: 'empty', target, events: [] }], maxOperations: 0 })).toMatchObject({ status: 'LIMIT_EXCEEDED', omitted: 1 });
  });

  it('deduplicates a target only after every relevant path approves it', () => {
    const path: ApprovalPathV2 = { pathId: 'p', target, events: [{ kind: 'APPROVAL', tool: 'mailer', effect: 'SEND_MESSAGE', argumentPaths: ['/to', '/body'] }] };
    expect(proveApprovalV2({ target, paths: [path, { ...path, pathId: 'retry-path' }] }).matchedTargets).toHaveLength(1);
    expect(proveApprovalV2({ target, paths: [path, { pathId: 'bypass', target, events: [] }] }).matchedTargets).toEqual([]);
  });
  it('suppresses partial path evidence when a later path exhausts the budget', () => {
    const input = { target, paths: [approved(), { ...approved(), pathId: 'later' }], maxOperations: 2 } as ApprovalProofInputV2;
    expect(proveApprovalV2(input)).toMatchObject({ status: 'LIMIT_EXCEEDED', pathResults: [], controlEvidence: [] });
  });
});
