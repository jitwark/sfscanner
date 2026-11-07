import { describe, expect, it } from 'vitest';
import type { ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import type { BatchItemV2, BatchResultV2 } from './batch-runner';
import { reduceExitV2, type ExitReducerOptionsV2, type ExitReductionV2 } from './exit-reducer';

const item = (status: BatchItemV2['status'], result?: unknown, code?: string): BatchItemV2 => ({
  label: 'item.json', status, ...(result === undefined ? {} : { result: { ok: true, result } as ScanWorkflowV2Result }),
  ...(code === undefined ? {} : { error: { code } as BatchItemV2['error'] }),
});
const batch = (...items: readonly BatchItemV2[]): BatchResultV2 => ({
  ok: true, items, cancelled: items.some((item) => item.status === 'CANCELLED'), completed: 0, failed: 0, concurrency: 1,
});
const result = (status: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE', findings: readonly string[] = []): unknown => ({
  analysis: { status }, findings: findings.map((severity) => ({ severity, effect: 'REPORT_ONLY' })),
});
const options = (overrides: Partial<ExitReducerOptionsV2> = {}): ExitReducerOptionsV2 => ({ failOn: 'INFO', requireComplete: false, ...overrides });

function expectExit(value: ExitReductionV2, reason: string, code: number): void {
  expect(value).toEqual({ reason, code });
}

describe('reduceExitV2', () => {
  it('reduces the exhaustive precedence independently of item order', () => {
    const vectors: readonly [BatchResultV2, ExitReducerOptionsV2, string, number][] = [
      [batch(item('CANCELLED', undefined, 'SCAN_CANCELLED')), options({ outputFailed: true }), 'CANCELLED', 130],
      [batch(item('FAILED', undefined, 'TOOL_INVARIANT_FAILED')), options(), 'INTERNAL', 4],
      [{ ok: false, code: 'INVALID_CONFIG', message: 'private' }, options(), 'USAGE', 2],
      [batch(item('COMPLETED', result('COMPLETE', ['INFO'])), item('COMPLETED', result('INDETERMINATE'))), options(), 'FINDING_THRESHOLD', 1],
      [batch(item('COMPLETED', result('DEGRADED'))), options({ requireComplete: true }), 'REQUIRE_COMPLETE', 1],
      [batch(item('COMPLETED', result('INDETERMINATE'))), options({ requireComplete: true }), 'ITEM_FAILURE', 3],
      [batch(item('FAILED', undefined, 'INVALID_JSON')), options({ requireComplete: true }), 'ITEM_FAILURE', 3],
      [batch(item('COMPLETED', result('COMPLETE'))), options(), 'UNDER_THRESHOLD', 0],
      [batch(item('FAILED', undefined, 'TOOL_INVARIANT_FAILED'), item('COMPLETED', result('COMPLETE', ['CRITICAL']))), options(), 'INTERNAL', 4],
      [batch(item('FAILED', undefined, 'SEMANTIC_CATALOGUE_INVALID'), item('COMPLETED', result('COMPLETE', ['CRITICAL']))), options(), 'FINDING_THRESHOLD', 1],
      [batch(item('FAILED', undefined, 'SEMANTIC_CATALOGUE_INVALID')), options(), 'ITEM_FAILURE', 3],
      [batch({ label: 'item.json', status: 'COMPLETED', result: { ok: false, code: 'SEMANTIC_CATALOGUE_INVALID', message: 'private' } }), options(), 'ITEM_FAILURE', 3],
      [{ ok: false, code: 'SEMANTIC_CATALOGUE_INVALID', message: 'private' } as unknown as BatchResultV2, options(), 'USAGE', 2],
    ];
    for (const [input, config, reason, code] of vectors) expectExit(reduceExitV2(input, config), reason, code);
    expectExit(reduceExitV2(batch(item('COMPLETED', result('INDETERMINATE')), item('COMPLETED', result('DEGRADED'))), options({ requireComplete: true })), 'REQUIRE_COMPLETE', 1);
  });

  it('counts report-only findings at every fail-on severity', () => {
    const vectors = [['CRITICAL', 'CRITICAL'], ['HIGH', 'HIGH'], ['MEDIUM', 'MEDIUM'], ['LOW', 'LOW'], ['INFO', 'INFO']] as const;
    for (const [failOn, finding] of vectors) {
      expectExit(reduceExitV2(batch(item('COMPLETED', result('COMPLETE', [finding]))), options({ failOn })), 'FINDING_THRESHOLD', 1);
    }
    expectExit(reduceExitV2(batch(item('COMPLETED', result('COMPLETE', ['INFO']))), options({ failOn: 'CRITICAL' })), 'UNDER_THRESHOLD', 0);
  });

  it('supports the object input form and never leaks malformed values', () => {
    expectExit(reduceExitV2({ batch: batch(item('COMPLETED', result('COMPLETE'))), failOn: 'INFO', requireComplete: false }), 'UNDER_THRESHOLD', 0);
    expectExit(reduceExitV2({ batch: null as never, failOn: 'not-a-severity' as never, requireComplete: 'no' as never }), 'USAGE', 2);
    expect(JSON.stringify(reduceExitV2({ batch: { ok: false, code: 'INVALID_CONFIG', message: '/private/path' } as never }))).not.toContain('/private/path');
  });

  it('gives interruption and output failure priority regardless of findings', () => {
    const findings = batch(item('COMPLETED', result('COMPLETE', ['CRITICAL'])));
    expectExit(reduceExitV2(findings, options({ interrupted: true })), 'CANCELLED', 130);
    expectExit(reduceExitV2(findings, options({ outputFailed: true })), 'INTERNAL', 4);
  });
});
