import {
  SCANNER_RESULT_SCHEMA_VERSION,
  type DescriptionProvenance,
  type Entry,
  type WorkflowChart,
} from '@hub/contracts';

export const DETAIL_RIGHTS_CLASSES = ['redistributable', 'link_only', 'excluded'] as const;
export const DETAIL_COMPLETENESS_STATES = ['complete', 'partial', 'unknown'] as const;
export const DETAIL_ANALYSIS_STATES = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'] as const;
export const DETAIL_GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'] as const;
export const DETAIL_GRAPH_SHAPES = ['small', 'medium', 'large', 'extreme', 'cyclic', 'disconnected', 'annotation-heavy', 'malformed'] as const;
export const DETAIL_DESCRIPTION_LEVELS = ['upstream-complete', 'upstream-missing-provenance', 'generated-explicit', 'generated-unknown', 'generated-missing-provenance', 'fallback'] as const;

export type DetailRightsClass = (typeof DETAIL_RIGHTS_CLASSES)[number];
export type DetailCompleteness = (typeof DETAIL_COMPLETENESS_STATES)[number];
export type DetailAnalysisStatus = (typeof DETAIL_ANALYSIS_STATES)[number];
export type DetailGrade = (typeof DETAIL_GRADES)[number];
export type DetailGraphShape = (typeof DETAIL_GRAPH_SHAPES)[number];
export type DetailDescriptionLevel = (typeof DETAIL_DESCRIPTION_LEVELS)[number];
export type DetailVariant = {
  readonly id: string;
  readonly dimensions: { rights: DetailRightsClass; completeness: DetailCompleteness; analysisStatus: DetailAnalysisStatus; grade: DetailGrade; graph: DetailGraphShape; description: DetailDescriptionLevel };
  readonly description: { source: Entry['descriptionSource']; provenance: DescriptionProvenance['source'] | 'missing'; hasContent: boolean };
  readonly chart: WorkflowChart | null;
  readonly malformedChart?: unknown;
  readonly entry: Entry;
  readonly expectations: { action: 'download' | 'source' | 'none'; body: 'included' | 'suppressed' | 'absent'; sourceFacts: 'complete' | 'partial'; descriptionPublishable: boolean };
};

type VariantSpec = Omit<DetailVariant['dimensions'], 'description'> & { id: string; description: DetailDescriptionLevel; sourceFacts: 'complete' | 'partial' };
const SPECS: readonly VariantSpec[] = [
  { id: 'detail-01-redistributable-complete-small-upstream', rights: 'redistributable', completeness: 'complete', analysisStatus: 'COMPLETE', grade: 'LOW', graph: 'small', description: 'upstream-complete', sourceFacts: 'complete' },
  { id: 'detail-02-redistributable-partial-medium-generated-unknown', rights: 'redistributable', completeness: 'partial', analysisStatus: 'DEGRADED', grade: 'MEDIUM', graph: 'medium', description: 'generated-unknown', sourceFacts: 'complete' },
  { id: 'detail-03-redistributable-unknown-cyclic-generated-missing', rights: 'redistributable', completeness: 'unknown', analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', graph: 'cyclic', description: 'generated-missing-provenance', sourceFacts: 'complete' },
  { id: 'detail-04-link-only-complete-large-upstream-missing', rights: 'link_only', completeness: 'complete', analysisStatus: 'COMPLETE', grade: 'HIGH', graph: 'large', description: 'upstream-missing-provenance', sourceFacts: 'partial' },
  { id: 'detail-05-link-only-partial-extreme-generated-explicit', rights: 'link_only', completeness: 'partial', analysisStatus: 'DEGRADED', grade: 'CRITICAL', graph: 'extreme', description: 'generated-explicit', sourceFacts: 'partial' },
  { id: 'detail-06-link-only-unknown-malformed-fallback', rights: 'link_only', completeness: 'unknown', analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', graph: 'malformed', description: 'fallback', sourceFacts: 'partial' },
  { id: 'detail-07-excluded-complete-disconnected-generated-explicit', rights: 'excluded', completeness: 'complete', analysisStatus: 'COMPLETE', grade: 'LOW', graph: 'disconnected', description: 'generated-explicit', sourceFacts: 'partial' },
  { id: 'detail-08-excluded-partial-annotation-heavy-upstream', rights: 'excluded', completeness: 'partial', analysisStatus: 'DEGRADED', grade: 'MEDIUM', graph: 'annotation-heavy', description: 'upstream-complete', sourceFacts: 'partial' },
  { id: 'detail-09-excluded-unknown-small-generated-unknown', rights: 'excluded', completeness: 'unknown', analysisStatus: 'INDETERMINATE', grade: 'UNKNOWN', graph: 'small', description: 'generated-unknown', sourceFacts: 'partial' },
  { id: 'detail-10-redistributable-complete-large-generated-explicit', rights: 'redistributable', completeness: 'complete', analysisStatus: 'COMPLETE', grade: 'CRITICAL', graph: 'large', description: 'generated-explicit', sourceFacts: 'complete' },
  { id: 'detail-11-link-only-complete-medium-upstream', rights: 'link_only', completeness: 'complete', analysisStatus: 'COMPLETE', grade: 'LOW', graph: 'medium', description: 'upstream-complete', sourceFacts: 'partial' },
  { id: 'detail-12-excluded-partial-cyclic-fallback', rights: 'excluded', completeness: 'partial', analysisStatus: 'DEGRADED', grade: 'HIGH', graph: 'cyclic', description: 'fallback', sourceFacts: 'partial' },
];

const SCORE: Record<DetailGrade, number> = { LOW: 92, MEDIUM: 68, HIGH: 41, CRITICAL: 12, UNKNOWN: 0 };
const COUNT: Record<DetailGrade, keyof Entry['security']['counts']> = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical', UNKNOWN: 'info' };

function nodes(shape: DetailGraphShape, count: number, annotations = 0): WorkflowChart['nodes'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${shape}-node-${index}`,
    name: `Synthetic ${shape} node ${index}`,
    type: index < annotations ? 'n8n-nodes-base.stickyNote' : 'n8n-nodes-base.httpRequest',
    x: index * 160,
    y: (index % 5) * 100,
    ...(index < annotations ? { isAnnotation: true } : {}),
  }));
}

function chartFor(shape: DetailGraphShape): WorkflowChart | null {
  if (shape === 'malformed') return null;
  const count = { small: 2, medium: 12, large: 40, extreme: 70, cyclic: 4, disconnected: 6, 'annotation-heavy': 8 }[shape];
  const annotationCount = shape === 'annotation-heavy' ? 4 : 0;
  const chartNodes = nodes(shape, count, annotationCount);
  let pairs = Array.from({ length: Math.max(0, count - 1) }, (_, index) => [index, index + 1] as const);
  if (shape === 'cyclic') pairs = [...pairs, [count - 1, 0]];
  if (shape === 'disconnected') pairs = [[0, 1], [1, 2], [3, 4]];
  return { nodes: chartNodes, edges: pairs.map(([from, to]) => ({ from: chartNodes[from]!.id, to: chartNodes[to]!.id, kind: 'main' })) };
}

function descriptionFor(level: DetailDescriptionLevel): DetailVariant['description'] & { text: string; provenanceValue?: DescriptionProvenance } {
  const generated = level.startsWith('generated');
  const source = level.startsWith('upstream') ? 'upstream' : level === 'fallback' ? 'fallback' : 'generated';
  const provenance = level === 'upstream-missing-provenance' || level === 'generated-missing-provenance' ? 'missing' : source === 'generated' ? (level === 'generated-unknown' ? 'unknown' : 'gemini') : source;
  const provenanceValue = provenance === 'missing' ? undefined : provenance === 'gemini' ? { source: 'gemini' as const, model: 'synthetic-model-v1' } : { source: provenance as 'upstream' | 'fallback' | 'unknown' };
  return { source, provenance, hasContent: generated, text: `Synthetic ${level} description.`, ...(provenanceValue ? { provenanceValue } : {}) };
}

function sourceFor(spec: VariantSpec): Entry['source'] {
  const base = { kind: spec.rights === 'link_only' ? 'n8n_official' as const : 'github' as const, permalink: `https://synthetic.example.test/detail/${spec.id}`, fetchedAt: '2026-08-31T00:00:00.000Z' };
  if (spec.sourceFacts === 'partial') return base;
  return { ...base, repo: 'synthetic/detail-fixtures', owner: 'Synthetic Maintainer', stars: 1, path: `fixtures/${spec.id}.json`, commit: 'a'.repeat(40), author: { name: 'Synthetic Maintainer', username: 'synthetic-maintainer', url: 'https://synthetic.example.test/maintainer' } };
}

function buildVariant(spec: VariantSpec): DetailVariant {
  const chart = chartFor(spec.graph);
  const description = descriptionFor(spec.description);
  const functionalNodes = spec.graph === 'annotation-heavy' ? 4 : chart?.nodes.length ?? 2;
  const rawNodes = chart?.nodes.length ?? 2;
  const entry: Entry = {
    id: spec.id, slug: spec.id, title: `Synthetic ${spec.graph} workflow`, summary: 'Synthetic detail contract fixture.', description: description.text, descriptionSource: description.source,
    ...(description.provenanceValue ? { descriptionProvenance: description.provenanceValue } : {}),
    ...(description.hasContent ? { descriptionContent: { headline: 'Synthetic explanation', summary: 'Synthetic summary.', outcome: 'A synthetic outcome.', beforeAfter: { before: 'Manual step.', after: 'Automated step.' }, exampleScenario: 'A synthetic example.', howItWorks: ['Inspect the synthetic input.'], limitations: ['Fixture only.'], audience: 'Test readers.' } } : {}),
    source: sourceFor(spec),
    rights: spec.rights === 'redistributable' ? { status: spec.rights, licence: 'MIT', licenceUrl: 'https://synthetic.example.test/licence/mit', reason: 'Synthetic fixture evidence for redistribution.' } : { status: spec.rights, licence: null, licenceUrl: null, reason: `Synthetic fixture ${spec.rights} rights; no body claim.` },
    structure: { nodeCount: functionalNodes, rawNodeCount: rawNodes, annotationNodeCount: rawNodes - functionalNodes, connectionCount: chart?.edges.length ?? 1, nodeTypes: ['n8n-nodes-base.httpRequest'], integrations: ['Synthetic HTTP'], trigger: 'Manual', isSubWorkflow: false, complexity: functionalNodes > 26 ? 'complex' : functionalNodes > 2 ? 'medium' : 'simple', hasCode: false, hasAI: false, hasWebhook: false, ...(spec.completeness === 'complete' ? {} : { partial: true }) },
    security: { grade: spec.grade, score: SCORE[spec.grade], counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0, [COUNT[spec.grade]]: spec.grade === 'UNKNOWN' ? 0 : 1 }, findings: [], hardenedExtra: 0, scannerVersion: 'detail-fixture-v1', profile: 'beta-default', schemaVersion: SCANNER_RESULT_SCHEMA_VERSION, analysisStatus: spec.analysisStatus, ...(spec.analysisStatus === 'DEGRADED' ? { analysisDiagnosticCodes: ['SOURCE_SPAN_UNAVAILABLE'] } : {}) },
    tags: ['synthetic', spec.graph], dedup: { fingerprint: `fingerprint-${spec.id}`, structuralHash: `structure-${spec.id}`, canonical: true, alsoFoundIn: [] },
    ...(spec.rights === 'redistributable' ? { download: { pack: 0, line: 0, offset: 0, length: 64 } } : {}),
    ...(spec.completeness === 'complete' ? { readiness: { credentials: [], replaceableValues: [], writeActions: [], aiModel: { present: false, model: null }, extraPackages: [], versionNotes: [], pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false } } : {}),
  };
  const body = spec.rights === 'redistributable' ? 'included' : spec.rights === 'link_only' ? 'suppressed' : 'absent';
  return { id: spec.id, dimensions: spec, description, chart, ...(spec.graph === 'malformed' ? { malformedChart: { nodes: [{ id: 'bad', name: 'Malformed fixture', type: 'n8n-nodes-base.httpRequest', x: 'not-a-number', y: 0 }], edges: [] } } : {}), entry, expectations: { action: spec.rights === 'redistributable' ? 'download' : spec.rights === 'link_only' ? 'source' : 'none', body, sourceFacts: spec.sourceFacts, descriptionPublishable: description.provenance === 'gemini' } };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const DETAIL_VARIANT_MATRIX: readonly DetailVariant[] = deepFreeze(SPECS.map(buildVariant));
