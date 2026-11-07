import { createDiagnostic, makeFact } from './adapter-evidence';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import { inventoryDestinations, type DestinationInventoryRecord, type DestinationInventoryResult } from '../analyzers/destinations/inventory';
import { sortDiagnostics } from '../diagnostics/identity';
import { resolveNodeSemanticsForScan } from '../semantics/generic-fallback';
import type { ResolvedNodeSemanticsV2, SemanticCatalogueV2 } from '../semantics/catalogue-schema';
import type { ReadonlySourceDocumentV2, SourceMemberRefV2 } from '../source/source-types';
import type { SemanticFieldV2, SecurityWorkflowV2 } from '../workflow-v2/security-workflow';
import type { SafeFactV2 } from './scheduler';

export type SemanticContextV2 = Readonly<{
  facts: readonly SafeFactV2[];
  diagnostics: readonly AnalysisDiagnosticV2[];
}>;

export function resolveAnalyzerSemanticContext(input: Readonly<{
  source: ReadonlySourceDocumentV2;
  workflow: SecurityWorkflowV2;
  catalogue: SemanticCatalogueV2;
  capabilityId: string;
  required: boolean;
}>): SemanticContextV2 {
  const diagnostics: AnalysisDiagnosticV2[] = [];
  const resolved = new Map<string, ResolvedNodeSemanticsV2>();
  for (const node of input.workflow.nodes) {
    const resolution = resolveNodeSemanticsForScan(input.catalogue, node);
    if (resolution === null) diagnostics.push(createDiagnostic('SEMANTIC_CATALOGUE_MISS', input.capabilityId, input.required, node.ref.source));
    else {
      resolved.set(node.ref.identityDigest, resolution.semantics);
      // Two meanings, never one substitute for the other. The miss says the node type has no
      // admitted catalogue record (the same code the fail-closed path uses at caller requiredness);
      // the capability code says the verdict rests on unmodelled-capability defaults whose
      // destinations are unknown, not audited-and-empty. Both are per node at that node's source
      // location and both are degraded/eligible, so the report's coverage section names exactly
      // which nodes rest on the assumption without withholding the workflow's verdict.
      if (resolution.origin === 'GENERIC_FALLBACK') {
        diagnostics.push(createDiagnostic('SEMANTIC_CATALOGUE_MISS', input.capabilityId, false, node.ref.source));
        diagnostics.push(createDiagnostic('GENERIC_NODE_UNMODELED_CAPABILITY', input.capabilityId, false, node.ref.source));
      }
    }
  }
  const factsById = new Map<string, SafeFactV2>();
  for (const fact of destinationFacts(input.workflow, resolved)) if (!factsById.has(fact.factId)) factsById.set(fact.factId, fact);
  const facts = [...factsById.values()];
  facts.sort((left, right) => compareStrings(left.factId, right.factId));
  return Object.freeze({
    facts: Object.freeze(facts),
    diagnostics: sortDiagnostics(diagnostics, [input.capabilityId]),
  });
}

function destinationFacts(workflow: SecurityWorkflowV2, semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2>): SafeFactV2[] {
  const sources = new Map<string, SourceMemberRefV2[]>();
  for (const node of workflow.nodes) {
    const fields: SemanticFieldV2[] = [];
    collectFields(node.parameters, fields);
    for (const field of fields) {
      const parameterPath = relativeParameterPath(node.ref.source.pointer, field.pointer);
      if (parameterPath === undefined) continue;
      for (const source of field.occurrences) {
        const key = `${node.ref.identityDigest}\u0000${parameterPath}`;
        const values = sources.get(key);
        if (values === undefined) sources.set(key, [source]);
        else values.push(source);
      }
    }
  }
  const inventory = inventoryDestinations(workflow, semantics);
  const facts: SafeFactV2[] = [];
  for (const record of inventory.records) {
    const node = workflow.nodes.find((candidate) => candidate.ref.identityDigest === record.nodeIdentity);
    if (node === undefined) continue;
    const key = `${record.nodeIdentity}\u0000${record.parameterPath}`;
    const source = sources.get(key)?.shift() ?? node.ref.source;
    facts.push(...createDestinationFacts(record, source));
  }
  facts.push(createCoverageFact(inventory));
  return facts;
}

function relativeParameterPath(nodePointer: string, fieldPointer: string): string | undefined {
  const prefix = `${nodePointer}/parameters`;
  return fieldPointer.startsWith(`${prefix}/`) ? fieldPointer.slice(prefix.length) : undefined;
}

function collectFields(fields: readonly SemanticFieldV2[], output: SemanticFieldV2[]): void {
  for (const field of fields) {
    output.push(field);
    if (Array.isArray(field.value)) collectFields(field.value, output);
  }
}

function createDestinationFacts(record: DestinationInventoryRecord, source: SourceMemberRefV2): SafeFactV2[] {
  const subject = Object.freeze({ kind: 'SOURCE' as const, source });
  const properties = Object.freeze({
    parameterPath: record.parameterPath,
    scheme: record.scheme,
    hostname: record.hostname,
    authorityState: record.authorityState,
    valueMode: record.valueMode,
  });
  const inventoryProperties = Object.freeze({
    parameterPath: record.parameterPath,
    scheme: record.scheme,
    hostname: record.hostname,
    authorityState: record.authorityState,
    valueMode: record.valueMode,
    reason: record.reason,
    omitted: record.omitted,
    inventoryStatus: record.inventoryStatus,
  });
  const legacy = makeFact('destination.v2', subject, properties);
  const current = makeFact('destination.v3', subject, inventoryProperties);
  return [
    Object.freeze({ factId: legacy.factId, kind: legacy.kind, subject, properties }),
    Object.freeze({ factId: current.factId, kind: current.kind, subject, properties: inventoryProperties }),
  ];
}

function createCoverageFact(inventory: DestinationInventoryResult): SafeFactV2 {
  const subject = Object.freeze({ kind: 'WORKFLOW' as const });
  const errorCodes = [...new Set(inventory.errors.map((error) => error.code))].sort(compareStrings);
  const properties = Object.freeze({
    inventoryStatus: inventory.status,
    nodesExamined: inventory.counters.nodesExamined,
    pathsConfigured: inventory.counters.pathsConfigured,
    recordsEmitted: inventory.counters.recordsEmitted,
    errors: inventory.errors.length,
    omitted: inventory.omitted,
    errorCodes: Object.freeze(errorCodes),
  });
  const fact = makeFact('destination.coverage.v1', subject, properties);
  return Object.freeze({ factId: fact.factId, kind: fact.kind, subject, properties });
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
