import type { SafeFactV2 } from '../../../../../contracts/scanner-v2-evidence';
import type { NodeRefV2, SourceMemberRefV2 } from '../../../../../contracts/scanner-v2-source';
import type { ScannerResultV2 } from '../../../../../contracts/scanner-v2-result';

const id = (character: string): string => character.repeat(64);
const digest = id('a');
const source: SourceMemberRefV2 = { pointer: '/nodes/0', occurrencePath: [0], astNodeId: digest, span: { start: { line: 1, column: 1, utf16Offset: 0, utf8ByteOffset: 0 }, end: { line: 1, column: 4, utf16Offset: 3, utf8ByteOffset: 3 } } };
const node: NodeRefV2 = { ordinal: 0, source, explicitId: 'command-node', name: 'Run command', identityDigest: id('b') };
const workflowFact = (factId: string, kind: string, properties: SafeFactV2['properties']): SafeFactV2 => ({ factId, kind, subject: { kind: 'WORKFLOW' }, properties });
const nodeFact: SafeFactV2 = { factId: id('d'), kind: 'node.capability.v2', subject: { kind: 'NODE', node }, properties: { nodeType: 'n8n-nodes-base.executeCommand', nodePackage: 'n8n-nodes-base', namespaceClass: 'OFFICIAL_BASE', capabilities: ['EXECUTE_COMMAND'], toolCount: 0, contextCount: 0 } };
const findingId = id('e');
export const V2_PROJECTION_FIXTURE: ScannerResultV2 = {
  schemaVersion: 'scanner-result-v2', engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest },
  input: { rawSha256: digest, semanticSha256: digest, ambiguitySha256: digest, ambiguityCount: 0, utf8Bytes: 128 },
  profile: { id: 'beta-default', version: '2.0.0' }, ruleset: { id: 'rules', version: '2.0.0', digest, signatureStatus: 'VERIFIED' },
  semantics: { id: 'semantics', version: '2.0.0', digest }, target: { schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [], contextDigest: digest },
  limits: { schemaVersion: 'scanner-limits-v2', digest, usage: [] }, analysis: { status: 'COMPLETE', capabilities: [], diagnostics: [] },
  workflow: { name: 'Fixture workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, triggerCount: 1, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 128, complexity: 'LOW', isSubWorkflow: false },
  facts: [
    workflowFact(id('0'), 'workflow.fingerprint.v1', { value: digest }),
    workflowFact(id('1'), 'workflow.summary.v1', { connectionCount: 0 }),
    workflowFact(id('2'), 'workflow.function.v1', { basicPurpose: 'Runs a command', triggerDescription: 'Triggered manually', dataFlowSummary: 'No connected data flow', businessCategory: 'MANUAL_AUTOMATION', confidence: 'HIGH' }),
    workflowFact(id('3'), 'workflow.risk-summary.v1', { topRisks: [], dataExposure: 'No external exposure was identified.', complexityDrivers: [] }),
    nodeFact,
  ], traces: [], findings: [{ findingId, ruleId: 'N8N_EXECUTE_COMMAND', ruleRevision: '1', effect: 'SCORING', severity: 'CRITICAL', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'NODE', node }, factRefs: [nodeFact.factId], traceRefs: [], remediationId: 'r' }],
  assessment: { score: 55, grade: 'HIGH', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [findingId], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
};
export const projectionFixture = V2_PROJECTION_FIXTURE;
