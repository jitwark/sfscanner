import { vi } from 'vitest';
import { scanWorkflowV2 } from './scan-workflow';
import * as model from '../analyzers/taint/scan-local-workflow-flow-model';
import * as runner from '../analyzers/taint/scan-local-traces';
import * as derivation from '../analyzers/taint/flow-coverage-derivation';
import * as publication from '../analyzers/taint/flow-coverage-publication';
import type { ScanLocalChargeV1 } from '../analyzers/taint/scan-local-state';

export const reviewedCommandFlow = {
  nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [100, 200], parameters: { httpMethod: 'POST', path: 'in' } },
    { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', typeVersion: 1,
      position: [300, 200], parameters: { command: '={{ $json.body.cmd }}' } },
  ],
  connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
} as const;

/** Observe real debits; every call delegates to its production counter, without granting work. */
export function measureFlowScan(workflow: unknown, maxGraphOperations = 100_000) {
  const events: { phase: string; units: number; accepted: boolean }[] = [];
  let depth = 0;
  let activePhase: string | undefined;
  const wrap = (phase: string, actual: ScanLocalChargeV1): ScanLocalChargeV1 => (units) => {
    const outer = depth++ === 0;
    try {
      const accepted = actual(units);
      if (outer) events.push({ phase: activePhase ?? phase, units, accepted });
      return accepted;
    } finally { depth--; }
  };
  const compile = model.compileScanLocalWorkflowFlowModelV1;
  const run = runner.runScanLocalWithWitnesses;
  const derive = derivation.deriveFlowCoverageV1;
  const publish = publication.publishFlowCoverageV1;
  const spies = [
    vi.spyOn(model, 'compileScanLocalWorkflowFlowModelV1').mockImplementation((input) => compile({ ...input, charge: wrap('MODEL', input.charge) })),
    vi.spyOn(runner, 'runScanLocalWithWitnesses').mockImplementation((input, witness) => {
      if (!input.charge) throw new Error('Expected shared workflow charge');
      return run({ ...input, charge: wrap('RUNNER', input.charge) }, witness);
    }),
    vi.spyOn(derivation, 'deriveFlowCoverageV1').mockImplementation((input, charge) => {
      const prior = activePhase; activePhase = 'DERIVATION';
      // Terminal admission checks the captured charge identity; observe it without replacing it.
      try { return derive(input, input.kind === 'TERMINAL' ? charge : wrap('DERIVATION', charge)); }
      finally { activePhase = prior; }
    }),
    vi.spyOn(publication, 'publishFlowCoverageV1').mockImplementation((input, charge) => publish(input, wrap('PUBLICATION', charge))),
  ];
  try {
    const outcome = scanWorkflowV2({ bytes: new TextEncoder().encode(JSON.stringify(workflow)),
      profile: { id: 'beta-default', version: '2.0.0' }, limits: { maxGraphOperations } });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    return { result: outcome.result, events,
      used: events.filter((event) => event.accepted).reduce((sum, event) => sum + event.units, 0) };
  } finally { for (const spy of spies) spy.mockRestore(); }
}
