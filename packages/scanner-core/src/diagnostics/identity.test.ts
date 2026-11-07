import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_REGISTRY, classifyDiagnostic, type AnalysisDiagnosticV2 } from './registry';
import { createDiagnosticId, sortDiagnostics } from './identity';

function location(astNodeId: string, pointer: string, occurrencePath: number[], span = 1) {
  return { astNodeId, pointer, occurrencePath, span: { start: { line: span, column: 1, utf16Offset: span, utf8ByteOffset: span }, end: { line: span, column: 2, utf16Offset: span + 1, utf8ByteOffset: span + 1 } } } as const;
}
function identityOf(input: AnalysisDiagnosticV2) { const { id: _id, ...identity } = input; return identity; }
function diagnostic(overrides: Partial<AnalysisDiagnosticV2> = {}): AnalysisDiagnosticV2 {
  const base = { id: 'placeholder', code: 'SOURCE_SPAN_UNAVAILABLE' as const, category: 'SOURCE' as const, capabilityId: 'capability-a', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, location: location('ast-a', '/nodes/0', [0]), observed: 1, maximum: 2, omitted: 0 } satisfies AnalysisDiagnosticV2;
  const value = { ...base, ...overrides }; return { ...value, id: createDiagnosticId(identityOf(value)) };
}
function diagnosticForCode(code: AnalysisDiagnosticV2['code'], capabilityRequiredness?: boolean): AnalysisDiagnosticV2 {
  const classification = classifyDiagnostic(code, capabilityRequiredness);
  return diagnostic({ code, category: classification.category, aggregateEffect: classification.aggregateEffect, assessmentEligible: classification.assessmentEligible });
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested); Object.freeze(value); }
  return value;
}
function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return; expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value as Record<string, unknown>)) expectDeepFrozen(nested);
}

describe('v2 diagnostic identity and ordering', () => {
  it('matches an independently computed golden vector and changes for every identity tuple field', () => {
    const first = diagnostic();
    const spanOnly = diagnostic({ location: location('ast-a', '/nodes/0', [0], 99) });
    const sourceCoordinatesOnly = diagnostic({ location: location('ast-a', '/other', [9], 99) });
    const changedTupleFields = [diagnostic({ capabilityId: 'capability-b' }), diagnosticForCode('DUPLICATE_FINDING_COLLAPSED'), diagnostic({ location: location('ast-b', '/nodes/0', [0]) }), diagnostic({ observed: 2 }), diagnostic({ maximum: 3 }), diagnostic({ omitted: 1 })];
    const optional = diagnosticForCode('JAVASCRIPT_PARSE_FAILED', false);
    const required = diagnostic({ code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER', aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    expect(first.id).toBe('de828e7abfbca97f2e6540ae8e0b5c99563b784bdddbd6c2e9a847954e0e2149');
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.id).toBe(createDiagnosticId(identityOf(first)));
    expect(first.id).toBe(spanOnly.id);
    expect(first.id).toBe(sourceCoordinatesOnly.id);
    for (const changed of changedTupleFields) expect(changed.id).not.toBe(first.id);
    expect(required.id).not.toBe(optional.id);
  });

  it('rejects missing capability IDs, invalid effects, and unsafe numeric fields', () => {
    const base = diagnostic();
    expect(() => createDiagnosticId({ ...base, capabilityId: '' })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, aggregateEffect: 'BROKEN' as never })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, observed: Number.NaN })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, maximum: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, omitted: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, category: 'WRONG' as never })).toThrow(TypeError);
  });

  it('sorts without construction-order or locale dependence and collapses duplicate identities', () => {
    const nullLocation = diagnostic({ capabilityId: 'cap-a', code: 'DUPLICATE_FINDING_COLLAPSED', category: 'POLICY', location: undefined });
    const unicode = diagnostic({ capabilityId: 'cap-a', location: location('ast-unicode', '/😀', [0]) });
    const accent = diagnostic({ capabilityId: 'cap-a', location: location('ast-accent', '/é', [0]) });
    const numericTwo = diagnostic({ capabilityId: 'cap-a', location: location('ast-two', '/same', [1, 2]) });
    const numericTen = diagnostic({ capabilityId: 'cap-a', location: location('ast-ten', '/same', [1, 10]) });
    const duplicate = diagnostic({ capabilityId: 'cap-a', location: location('ast-unicode', '/😀', [0], 100) });
    const result = sortDiagnostics([numericTen, nullLocation, duplicate, unicode, numericTwo, accent], ['cap-a']);
    expect(result.map((item) => item.location?.pointer ?? null)).toEqual(['/same', '/same', '/é', '/😀', null]);
    expect(result[0].location?.occurrencePath).toEqual([1, 2]);
    expect(result).toHaveLength(5);
    expect(result.filter((item) => item.location?.astNodeId === 'ast-unicode')).toHaveLength(1);
    expect(result.every((item) => item.id === createDiagnosticId(identityOf(item)))).toBe(true);
  });

  it('orders every capability permutation identically using the supplied multi-capability order', () => {
    const first = diagnostic({ capabilityId: 'cap-a', location: location('ast-a', '/a', [0]) });
    const second = diagnostic({ capabilityId: 'cap-b', location: location('ast-b', '/b', [0]) });
    const third = diagnostic({ capabilityId: 'cap-c', location: location('ast-c', '/c', [0]) });
    const expected = sortDiagnostics([first, second, third], ['cap-c', 'cap-a', 'cap-b']);
    expect(sortDiagnostics([third, first, second], ['cap-c', 'cap-a', 'cap-b'])).toEqual(expected);
    expect(expected.map((item) => item.capabilityId)).toEqual(['cap-c', 'cap-a', 'cap-b']);
  });

  it('uses registry order independently of diagnostic construction order', () => {
    const codes = ['COMPATIBILITY_PROJECTION_LOSS', 'SOURCE_SPAN_UNAVAILABLE', 'OPTIONAL_LIMIT_EXCEEDED', 'DUPLICATE_METADATA_KEY'] as const;
    const selectedCodes = new Set<AnalysisDiagnosticV2['code']>(codes);
    const constructed = codes.map((code) => diagnosticForCode(code));
    const expectedCodes = DIAGNOSTIC_REGISTRY.filter(({ code }) => selectedCodes.has(code)).map(({ code }) => code);
    const permutations = [[constructed[2], constructed[0], constructed[3], constructed[1]], [constructed[1], constructed[3], constructed[0], constructed[2]]];
    expect(sortDiagnostics(constructed, ['capability-a']).map(({ code }) => code)).toEqual(expectedCodes);
    for (const permutation of permutations) expect(sortDiagnostics(permutation, ['capability-a']).map(({ code }) => code)).toEqual(expectedCodes);
  });

  it('collapses non-adjacent duplicate IDs independently of location ordering', () => {
    const duplicateAtZ = diagnostic({ location: location('ast-duplicate', '/z', [0], 1) });
    const interposed = diagnostic({ location: location('ast-interposed', '/m', [0], 2) });
    const duplicateAtA = diagnostic({ location: location('ast-duplicate', '/a', [0], 3) });
    const result = sortDiagnostics([duplicateAtZ, interposed, duplicateAtA], ['capability-a']);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((item) => item.id)).size).toBe(2);
    expect(result.some((item) => item.id === duplicateAtZ.id)).toBe(true);
  });

  it('makes a collapsed duplicate independent of all source span coordinates', () => {
    const narrow = diagnostic({ location: location('ast-duplicate', '/same', [0], 1) });
    const wide = diagnostic({ location: location('ast-duplicate', '/same', [0], 20) });
    const shifted = diagnostic({ location: location('ast-duplicate', '/same', [0], 100) });
    const first = sortDiagnostics([narrow, wide], ['capability-a']);
    const second = sortDiagnostics([shifted, wide], ['capability-a']);
    expect(first).toEqual(second);
    expect(first[0].location?.span).toBeNull();
  });

  it('rejects fixed registry classification mismatches instead of rewriting them', () => {
    const base = identityOf(diagnostic());
    expect(() => createDiagnosticId({ ...base, assessmentEligible: false })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, aggregateEffect: 'INDETERMINATE' })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, category: 'POLICY' })).toThrow(TypeError);
  });

  it('rejects sparse paths, custom prototypes, symbols, and unknown keys before comparison', () => {
    const base = identityOf(diagnostic());
    const sparsePath = [0, , 2] as number[];
    const sparseLocation = { ...base.location!, occurrencePath: sparsePath };
    const inheritedLocation = Object.assign(Object.create({ inherited: true }), base.location!);
    const symbolLocation = { ...base.location! };
    Object.defineProperty(symbolLocation, Symbol('unexpected'), { value: true });
    expect(() => createDiagnosticId({ ...base, location: sparseLocation })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, location: inheritedLocation })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, location: symbolLocation })).toThrow(TypeError);
    expect(() => createDiagnosticId({ ...base, unexpected: 'secret' } as never)).toThrow(TypeError);
  });

  it('accepts explicit numeric boundaries for every count and rejects above maximum', () => {
    const base = identityOf(diagnostic());
    const maximum = Number.MAX_SAFE_INTEGER;
    for (const field of ['observed', 'maximum', 'omitted'] as const) {
      for (const value of [0, maximum - 1, maximum]) expect(createDiagnosticId({ ...base, [field]: value })).toMatch(/^[0-9a-f]{64}$/);
      expect(() => createDiagnosticId({ ...base, [field]: maximum + 1 })).toThrow(TypeError);
    }
  });

  it('deeply freezes every returned structure and leaves the complete input graph unchanged', () => {
    const input = freezeDeep([diagnostic({ location: location('ast-a', '/nodes/0', [0], 1) }), diagnostic({ capabilityId: 'capability-b', location: location('ast-b', '/nodes/1', [1, 0], 2) })]);
    const originalInput = structuredClone(input);
    const result = sortDiagnostics(input, ['capability-a', 'capability-b']);
    expect(input).toEqual(originalInput);
    expectDeepFrozen(result);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    for (const item of result) {
      expect(Object.isFrozen(item)).toBe(true);
      if (item.location === undefined) continue;
      expect(Object.isFrozen(item.location)).toBe(true);
      expect(Object.isFrozen(item.location.occurrencePath)).toBe(true);
      if (item.location.span === null) continue;
      expect(Object.isFrozen(item.location.span)).toBe(true);
      expect(Object.isFrozen(item.location.span.start)).toBe(true);
      expect(Object.isFrozen(item.location.span.end)).toBe(true);
    }
  });

  it('uses generic non-leaking errors for secret-bearing malformed inputs', () => {
    const secret = 'vault-secret-7f3d';
    const sourceText = '{"password":"source-secret-91ac"}';
    const exceptionText = 'SyntaxError: unexpected token at source line 7';
    const base = identityOf(diagnostic());
    const malformedIdentity = { ...base, location: { ...base.location!, pointer: sourceText, span: { ...base.location!.span!, start: { ...base.location!.span!.start, line: secret as never } } } } as never;
    const malformedDiagnostic = { ...diagnostic(), id: exceptionText, location: { ...base.location!, pointer: sourceText, occurrencePath: [secret] as never } } as never;
    const captureMessage = (run: () => unknown): string => { try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); } throw new Error('Expected malformed input to throw'); };
    const messages = [captureMessage(() => createDiagnosticId(malformedIdentity)), captureMessage(() => sortDiagnostics([malformedDiagnostic], ['capability-a']))];
    expect(messages).toEqual(['Invalid diagnostic identity', 'Invalid diagnostic collection']);
    for (const message of messages) { expect(message).not.toContain(secret); expect(message).not.toContain(sourceText); expect(message).not.toContain(exceptionText); }
  });
});
