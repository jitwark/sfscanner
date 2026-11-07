import { describe, expect, it } from 'vitest';
import { applyAdvisorEvent, applyMainEvent, createMainScanState, createTelemetrySkeleton } from './omp-telemetry-events.mjs';

const message = (content, usage) => ({ type: 'message', message: { role: 'assistant', content, usage } });

describe('telemetry event accounting', () => {
  it('combines assistant and model usage without charging cache-only events', () => {
    const telemetry = createTelemetrySkeleton();
    const state = createMainScanState();
    for (const event of [
      message([], { input: 10, output: 4, cacheRead: 3, reasoningTokens: 2, cost: { total: 0.25 } }),
      { type: 'model_usage', usage: { input: 5, output: 6, cacheRead: 7, reasoningTokens: 1, cost: { total: 0.5 } } },
      { type: 'model_usage', usage: { cacheRead: 99, cost: { total: 9 } } },
      { type: 'model_usage', usage: { totalTokens: 1, cacheRead: 2 } },
    ]) applyMainEvent(telemetry, state, event);
    expect(telemetry.tokensAndEfficiency).toMatchObject({
      totalInputTokens: 15, totalOutputTokens: 10, totalCacheReadTokens: 12,
      totalReasoningTokens: 3, totalCostUsd: 0.75,
    });
  });

  it('attributes tool errors to the matching call rather than the latest call', () => {
    const telemetry = createTelemetrySkeleton();
    const state = createMainScanState();
    applyMainEvent(telemetry, state, message([
      { type: 'toolCall', id: 'first', name: 'edit', arguments: { path: 'one.ts' } },
      { type: 'toolCall', id: 'second', name: 'edit', arguments: { path: 'two.ts' } },
      { type: 'thinking', thinking: 'abcd' }, { type: 'text', text: 'xy' },
    ]));
    applyMainEvent(telemetry, state, { type: 'message', timestamp: '2026-01-01T01:00:00Z', message: {
      role: 'toolResult', toolCallId: 'first', toolName: 'edit', isError: true, details: 'synthetic failure',
    } });
    expect(telemetry.tools).toMatchObject({ totalCalls: 2, totalResults: 1, totalErrors: 1, errorsByName: { edit: 1 } });
    expect(telemetry.tools.errorDetails).toEqual([{
      toolName: 'edit', toolCallId: 'first', timestamp: '2026-01-01T01:00:00Z',
      args: { path: 'one.ts' }, details: 'synthetic failure',
    }]);
    expect(telemetry.tokensAndEfficiency).toMatchObject({ thinkingCharacters: 4, textCharacters: 2 });
  });

  it('accepts advisor aliases and applies topic precedence before lower-ranked matches', () => {
    const telemetry = createTelemetrySkeleton();
    applyAdvisorEvent(telemetry, message([
      { type: 'tool_call', function: { name: 'advise', arguments: JSON.stringify({ severity: 'blocker', note: 'clean provenance schema' }) } },
      { type: 'toolCall', name: 'advise', arguments: { severity: 'concern', note: 'concurrent windows budget' } },
      { type: 'toolCall', name: 'advise', arguments: { note: 'schema digest' } },
    ]));
    expect(telemetry.advisor.totalAdviseCalls).toBe(3);
    expect(telemetry.advisor.severityCounts).toEqual({ blocker: 1, concern: 1, nit: 0, unspecified: 1 });
    expect(telemetry.advisor.topics).toEqual({ git_hygiene_and_staging: 1, concurrency_and_freeze: 1, contracts_and_types: 1 });
    expect(telemetry.advisor.blockers.map(entry => entry.note)).toEqual(['clean provenance schema']);
    expect(telemetry.advisor.keyConcerns.map(entry => entry.note)).toEqual(['concurrent windows budget']);
  });
});
