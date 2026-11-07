import { describe, expect, it } from 'vitest';
import vectors from '../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';
import { readFieldFlowPropertiesV1, validateFieldFlowProperties, validateFieldFlowSubject } from './scanner-v2-field-flow-validation';

const [provenance, summary, coverage] = vectors.facts;
const accepts = (fact: typeof provenance, properties: Record<string, unknown> = fact.properties) =>
  validateFieldFlowProperties(fact.kind, properties);
const summaryWith = (properties: Record<string, unknown>) => accepts(summary, { ...summary.properties, ...properties });

describe('closed field-flow fact admission', () => {
  it.each(vectors.facts)('admits frozen $kind properties and rejects every missing or extra property', (fact) => {
    expect(accepts(fact)).toBe(true);
    for (const key of Object.keys(fact.properties)) {
      const { [key]: omitted, ...remaining } = fact.properties as Record<string, unknown>;
      void omitted;
      expect(accepts(fact, remaining)).toBe(false);
    }
    expect(accepts(fact, { ...fact.properties, unexpected: 0 })).toBe(false);
  });

  it('binds origin identity to the provenance subject, not display labels', () => {
    expect(validateFieldFlowSubject(provenance.kind, provenance.subject, provenance.properties)).toBe(true);
    expect(validateFieldFlowSubject(provenance.kind, summary.subject, provenance.properties)).toBe(false);
    expect(validateFieldFlowSubject(provenance.kind, { kind: 'WORKFLOW' }, provenance.properties)).toBe(false);
    expect(validateFieldFlowSubject(coverage.kind, { kind: 'WORKFLOW' }, coverage.properties)).toBe(true);
    expect(validateFieldFlowSubject(coverage.kind, provenance.subject, coverage.properties)).toBe(false);
    expect(validateFieldFlowSubject(summary.kind, summary.subject, summary.properties)).toBe(true);
    expect(validateFieldFlowSubject(summary.kind, { kind: 'NODE', node: null }, summary.properties)).toBe(false);
    expect(validateFieldFlowSubject(provenance.kind, { kind: 'NODE', node: {} }, {})).toBe(false);
  });

  it('checks label channels, reserved CONTROL, canonical order and duplicates', () => {
    expect(summaryWith({ taintChannel: 'INTEGRITY', taintLabels: ['MODEL_OUTPUT', 'TOOL_RESULT'] })).toBe(true);
    for (const properties of [
      { taintChannel: 'CONTROL' }, { taintLabels: [] }, { taintLabels: ['TOOL_RESULT'] },
      { taintChannel: 'INTEGRITY', taintLabels: ['WEBHOOK_BODY'] },
      { taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_BODY'] },
      { taintChannel: 'INTEGRITY', taintLabels: ['TOOL_RESULT', 'MODEL_OUTPUT'] },
      { taintLabels: ['UNREVIEWED_LABEL'] },
    ]) expect(summaryWith(properties)).toBe(false);
  });

  it('keeps all ten reviewed classes and six endpoint/edge channels independent', () => {
    for (const sinkClass of ['COMMAND', 'SQL', 'HTML', 'HTTP_DESTINATION', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT', 'TOOL_CONTROL']) {
      for (const sinkChannel of ['DATA', 'CONTROL', 'ERROR', 'MODEL', 'TOOL', 'CONTEXT']) {
        expect(summaryWith({ sinkClass, sinkChannel, edgeChannel: 'CONTEXT' })).toBe(true);
      }
    }
    expect(summaryWith({ sinkClass: 'URL' })).toBe(false);
    expect(summaryWith({ edgeChannel: 'UNKNOWN' })).toBe(false);
  });

  it('validates whole paths, UTF-8 bounds and decoded RFC6901 segments without rejecting code-like keys', () => {
    for (const sourceFieldPath of [[], ['return', 'a/b', '~'], ['é'.repeat(128)], Array(32).fill('a')]) {
      expect(summaryWith({ sourceFieldPath })).toBe(true);
    }
    expect(summaryWith({ sinkParameterPath: '/return/a~1b/~0' })).toBe(true);
    for (const segment of ['', 'é'.repeat(129), '\u0000', '\n', '\u200b', '\ud800', '../private', 'https://canary.invalid', 'secret=canary', 'source: canary']) {
      expect(summaryWith({ sourceFieldPath: ['safe', segment, 'sibling'] })).toBe(false);
    }
    expect(summaryWith({ sourceFieldPath: Array(33).fill('a') })).toBe(false);
    for (const sinkParameterPath of ['/a~2b', '/a~', '/safe/secret=canary', '/safe/..', '/é'.repeat(700)]) {
      expect(summaryWith({ sinkParameterPath })).toBe(false);
    }
    expect(summaryWith({ propertyPath: '/safe/secret=canary' })).toBe(false);
  });

  it('does not execute getters or accept sparse, inherited or symbolic property containers', () => {
    let reads = 0;
    const accessor = Object.defineProperty({ ...summary.properties }, 'sinkClass', { get() { reads += 1; return 'COMMAND'; } });
    expect(accepts(summary, accessor)).toBe(false);
    const listAccessor = Object.defineProperty(['WEBHOOK_BODY'], '0', { get() { reads += 1; return 'WEBHOOK_BODY'; } });
    expect(summaryWith({ taintLabels: listAccessor })).toBe(false);
    expect(reads).toBe(0);
    expect(summaryWith({ sourceFieldPath: new Array(1) })).toBe(false);
    expect(accepts(summary, Object.assign(Object.create({ inherited: true }), summary.properties))).toBe(false);
    expect(accepts(summary, { ...summary.properties, [Symbol('hidden')]: true })).toBe(false);
  });

  it('keeps knowledge and omissions coherent without making origin-state claims', () => {
    expect(summaryWith({ knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'] })).toBe(true);
    expect(summaryWith({ knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedAtoms: 1 })).toBe(true);
    for (const properties of [
      { knowledge: 'UNKNOWN' }, { unknownReasons: ['DYNAMIC_FIELD'] }, { omittedAtoms: 1 },
      { knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'], omittedSanitizers: 1 },
      { unknownReasons: ['PAYLOAD_LIMIT', 'DYNAMIC_FIELD'], knowledge: 'UNKNOWN' },
      { sourceNodeDigest: 'A'.repeat(64) }, { sourceProvenanceFactId: 'not-a-digest' },
    ]) expect(summaryWith(properties)).toBe(false);
    expect(accepts(provenance, { ...provenance.properties, knowledge: 'KNOWN' })).toBe(false);
  });

  it('rejects forged, unauthorized and wrong-path sanitizer tokens and tokens that suppress their own summary', () => {
    const pathDigest = '977111179f141b65407aed15862eb63df5666a6aefb3249d974e4f9e00d1d445';
    const header = `v1/sf.san.v1.encode-uri-component/HEADER/${pathDigest}`;
    expect(summaryWith({ sanitizedFor: [header] })).toBe(true);
    expect(summaryWith({ sinkClass: 'HEADER', sanitizedFor: [header] })).toBe(false);
    expect(summaryWith({ sinkClass: 'HEADER', knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'], sanitizedFor: [header] })).toBe(true);
    for (const model of ['number', 'parse-int', 'parse-float']) {
      for (const sink of ['SQL', 'COMMAND', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT']) {
        const token = `v1/sf.san.v1.${model}/${sink}/${pathDigest}`;
        expect(summaryWith({ sinkClass: 'HTML', sanitizedFor: [token] })).toBe(true);
        expect(summaryWith({ sinkClass: sink, sanitizedFor: [token] })).toBe(false);
      }
    }
    expect(summaryWith({ sanitizedFor: [header, header] })).toBe(false);
    expect(summaryWith({ sanitizedFor: [header], sinkFieldPath: ['another'] })).toBe(false);
    expect(summaryWith({ sanitizedFor: [`v1/sf.san.v1.number/HTML/${pathDigest}`] })).toBe(false);
    expect(summaryWith({ sanitizedFor: [`v1/sf.san.v1.encode-uri/HEADER/${pathDigest}`] })).toBe(false);
    for (const sanitizedFor of [
      ['v1/not-reviewed/HEADER/' + 'a'.repeat(64)],
      ['v1/sf.san.v1.number/HTML/' + 'a'.repeat(64)],
      ['v1/sf.san.v1.encode-uri-component/HEADER/' + 'a'.repeat(64)],
      ['v1/sf.san.v1.encode-uri/HEADER/' + 'a'.repeat(64)],
      ['v2/sf.san.v1.number/SQL/' + 'a'.repeat(64)],
    ]) expect(summaryWith({ sanitizedFor })).toBe(false);
  });

  it('enforces coverage arithmetic, complete/failed claims and safe integer bounds', () => {
    const withCoverage = (properties: Record<string, unknown>) => accepts(coverage, { ...coverage.properties, ...properties });
    expect(withCoverage({ coverageStatus: 'LIMITED', witnessUnavailable: 1 })).toBe(true);
    expect(withCoverage({ coverageStatus: 'LIMITED', fieldsExamined: 3, unknownFields: 1, unknownReasons: ['DYNAMIC_FIELD'] })).toBe(true);
    const failed = { ...Object.fromEntries(Object.entries(coverage.properties).map(([key, value]) => [key, typeof value === 'number' ? 0 : value])), coverageStatus: 'FAILED' };
    expect(accepts(coverage, failed)).toBe(true);
    expect(accepts(coverage, { ...failed, emittedFlows: 1 })).toBe(false);
    expect(accepts(coverage, { ...failed, suppressedFlows: 1 })).toBe(false);
    for (const properties of [
      { fieldsExamined: -1 }, { fieldsExamined: Number.MAX_SAFE_INTEGER + 1 },
      { knownFields: '2' }, { emittedFlows: '1' }, { omittedAtoms: '0' },
      { fieldsExamined: 0, knownFields: 1 }, { knownEmptyFields: Number.MAX_SAFE_INTEGER },
      { positiveFields: Number.MAX_SAFE_INTEGER }, { coverageStatus: 'COMPLETE', unknownFields: 1 },
      { coverageStatus: 'FAILED', fieldsExamined: 1 }, { capabilityId: 'agentic-control' },
      { unknownReasons: ['DYNAMIC_FIELD'], unknownFields: 0 }, { taintChannels: ['CONTROL'] },
      { sinkChannels: ['UNREVIEWED'] }, { edgeChannels: ['DATA', 'DATA'] },
    ]) expect(withCoverage(properties)).toBe(false);
  });

  it('returns an immutable accepted snapshot independent of later producer mutations', () => {
    const properties = { ...summary.properties, sourceFieldPath: ['original'] };
    const accepted = readFieldFlowPropertiesV1(summary.kind, properties)!;
    properties.sourceFieldPath[0] = 'replacement';
    expect(accepted.sourceFieldPath).toEqual(['original']);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.sourceFieldPath)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(false);
  });
});
