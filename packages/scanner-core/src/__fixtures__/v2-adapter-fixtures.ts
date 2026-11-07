import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import type { ScanWorkflowV2FailureCode } from '../v2';

export const V2_ADAPTER_PROFILE: Readonly<{ id: 'beta-default'; version: '2.0.0' }> = Object.freeze({ id: 'beta-default', version: '2.0.0' });
export type V2AdapterFixtureKind = 'valid' | 'rejected';
export type V2AdapterFixtureClass = 'safe' | 'risky' | 'indeterminate' | 'malformed' | 'oversized' | 'unicode-bom' | 'duplicate' | 'ambiguous' | 'max-bound';
export type V2AdapterFixture = Readonly<{
  id: string;
  kind: V2AdapterFixtureKind;
  fixtureClass: V2AdapterFixtureClass;
  json: string;
  rejectionCode?: ScanWorkflowV2FailureCode;
  expectedStatus?: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';
}>;

const secretSentinel = 'sk_live_adapter_fixture_secret_123';
const workflow = (nodes: readonly unknown[], connections: Record<string, unknown> = {}): string => JSON.stringify({ nodes, connections });
const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, version?: number): Readonly<Record<string, unknown>> => ({
  id, name, type, ...(version === undefined ? {} : { typeVersion: version }), parameters,
});
const safe = workflow([]);
const risky = workflow([node('command', 'Run command', 'n8n-nodes-base.executeCommand', { command: `echo ${secretSentinel}` }, 1)]);
// The `indeterminate` class name predates the generic fallback and stays for fixture-matrix
// stability (the class set is pinned by `scripts/check-scanner-v2-parity.test.mjs`): the workflow is
// still the uncatalogued-namespace case, and it now grades DEGRADED under the labelled fallback
// instead of withholding the verdict. A genuinely unreadable node is exercised in
// `v2/generic-node-fallback.test.ts`.
const indeterminate = workflow([node('custom', 'Custom', '@example/custom-node.unknown')]);
const unicodeBom = `\uFEFF${workflow([node('安全', '安全', 'n8n-nodes-base.manualTrigger', {}, 1)])}`;
const duplicate = '{"nodes":[],"nodes":[],"connections":{}}';
const ambiguous = workflow([node('start', 'Start', 'n8n-nodes-base.manualTrigger')], {
  start: { main: [[{ node: 'missing', type: 'main', index: 0 }]] },
});
const maxBound = workflow([node('max', 'Max', 'n8n-nodes-base.manualTrigger', {
  values: Array.from({ length: DEFAULT_SCANNER_LIMITS_V2.maxParameterLeaves }, (_, index) => index),
}, 1)]);
const maxBoundExceeded = workflow([node('max', 'Max', 'n8n-nodes-base.manualTrigger', {
  values: Array.from({ length: DEFAULT_SCANNER_LIMITS_V2.maxParameterLeaves + 1 }, (_, index) => index),
})]);

// The max-bound row is catalogue-resolved (`manualTrigger` at its admitted version), so the pin is
// no longer what keeps the verdict from regressing to INDETERMINATE. The explicit `expectedStatus`
// stays so a semantic or limit regression that changes the verdict trips `FIXTURE_STATUS_MISMATCH`
// in `scripts/measure-scanner-v2.mjs:140` instead of passing the latency gate silently.
export const V2_ADAPTER_FIXTURE_MATRIX: readonly V2AdapterFixture[] = Object.freeze([
  Object.freeze({ id: 'safe-workflow', kind: 'valid', fixtureClass: 'safe', json: safe, expectedStatus: 'COMPLETE' }),
  Object.freeze({ id: 'risky-workflow', kind: 'valid', fixtureClass: 'risky', json: risky, expectedStatus: 'COMPLETE' }),
  Object.freeze({ id: 'indeterminate-workflow', kind: 'valid', fixtureClass: 'indeterminate', json: indeterminate, expectedStatus: 'DEGRADED' }),
  Object.freeze({ id: 'unicode-bom-workflow', kind: 'valid', fixtureClass: 'unicode-bom', json: unicodeBom, expectedStatus: 'COMPLETE' }),
  Object.freeze({ id: 'duplicate-workflow', kind: 'valid', fixtureClass: 'duplicate', json: duplicate, expectedStatus: 'INDETERMINATE' }),
  Object.freeze({ id: 'ambiguous-workflow', kind: 'valid', fixtureClass: 'ambiguous', json: ambiguous, expectedStatus: 'INDETERMINATE' }),
  Object.freeze({ id: 'max-bound-workflow', kind: 'valid', fixtureClass: 'max-bound', json: maxBound, expectedStatus: 'COMPLETE' }),
  Object.freeze({ id: 'malformed-workflow', kind: 'rejected', fixtureClass: 'malformed', json: '{"nodes":', rejectionCode: 'INVALID_JSON' }),
  Object.freeze({ id: 'oversized-workflow', kind: 'rejected', fixtureClass: 'oversized', json: `{"data":"${'x'.repeat(DEFAULT_SCANNER_LIMITS_V2.maxBytes)}"}`, rejectionCode: 'WORKFLOW_TOO_LARGE' }),
  Object.freeze({ id: 'max-bound-exceeded-workflow', kind: 'rejected', fixtureClass: 'max-bound', json: maxBoundExceeded, rejectionCode: 'WORKFLOW_TOO_COMPLEX' }),
]);
