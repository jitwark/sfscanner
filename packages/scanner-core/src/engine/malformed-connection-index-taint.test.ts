import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../workflow';
import { analyzeWorkflowTaint } from '../analyzers/taint/taint-analysis';
import { createBetaDefaultPolicies } from '../policies/beta-policies';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { scanWorkflowCore } from './engine';

// AUDIT-SCAN-001: a Webhook feeding an Execute Command node's shell command through
// `={{ $json.cmd }}` must be flagged by TAINTED_COMMAND when the connection's target
// index is a valid integer, and must NEVER silently drop that finding — with a clean
// COMPLETE status — just because the target index in the source JSON is malformed.
function triggerToExecuteCommand(sourceType: string, sourceName: string, targetIndex: unknown) {
  const nodes = [
    { id: 'w', name: sourceName, type: sourceType, parameters: {} },
    {
      id: 's', name: 'Sink', type: 'n8n-nodes-base.executeCommand',
      parameters: { command: '={{ $json.cmd }}' },
    },
  ];
  const connections = {
    [sourceName]: { main: [[{ node: 'Sink', type: 'main', index: targetIndex }]] },
  };
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return scanWorkflowCore(parsed.workflow, {
    policies: createBetaDefaultPolicies(),
    analyzers: [analyzeWorkflowTaint],
    ruleCatalog: betaHardenedRuleCatalog,
  });
}

function webhookToExecuteCommand(targetIndex: unknown) {
  return triggerToExecuteCommand('n8n-nodes-base.webhook', 'Webhook', targetIndex);
}

describe('AUDIT-SCAN-001 — malformed connection index vs. hardened taint propagation', () => {
  it('reports N8N_EXECUTE_COMMAND, WEBHOOK_EXPOSURE, and TAINTED_COMMAND as COMPLETE for a valid index', () => {
    const result = webhookToExecuteCommand(0);

    expect(result.findings.map((finding) => finding.policyId).sort()).toEqual(
      ['N8N_EXECUTE_COMMAND', 'TAINTED_COMMAND', 'WEBHOOK_EXPOSURE'].sort(),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.analysisStatus).toBe('COMPLETE');
  });

  it('reports inbound Telegram update taint reaching a command sink as COMPLETE', () => {
    const result = triggerToExecuteCommand(
      'n8n-nodes-base.telegramTrigger', 'Telegram Trigger', 0,
    );

    const taintFinding = result.findings.find((finding) => finding.policyId === 'TAINTED_COMMAND');
    expect(taintFinding).toMatchObject({
      evidence: {
        taintLabels: ['INBOUND_MESSAGE'],
        sourceNodeId: 'w',
        sourceNodeName: 'Telegram Trigger',
        tracePath: ['w', 's'],
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.analysisStatus).toBe('COMPLETE');
  });

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
  ])('never claims COMPLETE when the target index is %s: the taint edge is dropped WITH a diagnostic', (_label, index) => {
    const result = webhookToExecuteCommand(index);

    // The malformed index breaks the taint edge, so TAINTED_COMMAND cannot be computed —
    // but unlike before the fix, that omission must be visible, not silent.
    expect(result.findings.map((finding) => finding.policyId).sort()).toEqual(
      ['N8N_EXECUTE_COMMAND', 'WEBHOOK_EXPOSURE'].sort(),
    );
    expect(result.findings.some((finding) => finding.policyId === 'TAINTED_COMMAND')).toBe(false);
    expect(result.diagnostics).toContainEqual({
      code: 'MALFORMED_CONNECTION_INDEX',
      category: 'GRAPH',
      location: { path: '/connections/Webhook/main/0/0/index' },
    });
    expect(result.analysisStatus).not.toBe('COMPLETE');
    expect(result.analysisStatus).toBe('DEGRADED');
  });

  it('rejects a numeric-string index rather than silently coercing it', () => {
    const result = webhookToExecuteCommand('0');

    expect(result.findings.some((finding) => finding.policyId === 'TAINTED_COMMAND')).toBe(false);
    expect(result.diagnostics).toContainEqual({
      code: 'MALFORMED_CONNECTION_INDEX',
      category: 'GRAPH',
      location: { path: '/connections/Webhook/main/0/0/index' },
    });
    expect(result.analysisStatus).toBe('DEGRADED');
  });
});
