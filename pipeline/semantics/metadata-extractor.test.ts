import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACTION_LIMITS,
  extractMetadata,
  type Extraction,
  type ExtractionLimits,
  type MetadataCandidate,
} from './metadata-extractor.js';
import { validateExtraction } from './candidate-validator.js';
import { sourceReceiptDigest, validateSourceReceipt, type SourceReceipt } from './source-receipt.js';

const encoder = new TextEncoder();
const toBytes = (source: string | Uint8Array): Uint8Array =>
  (typeof source === 'string' ? encoder.encode(source) : source);
const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Fixture = Readonly<{ receipt: SourceReceipt; files: Map<string, Uint8Array> }>;

function fixture(sources: Readonly<Record<string, string | Uint8Array>>): Fixture {
  const files = new Map<string, Uint8Array>(
    Object.entries(sources).map(([path, source]) => [path, toBytes(source)]),
  );
  const validation = validateSourceReceipt({
    packageName: 'n8n-nodes-base',
    packageVersion: '2.15.1',
    artifactSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    licenseReceiptDigest: 'c'.repeat(64),
    files: [...files.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([path, content]) => ({ path, sha256: sha256(content) })),
  });
  if (!validation.ok) throw new Error(`fixture receipt invalid: ${validation.reason}`);
  return { receipt: validation.receipt, files };
}

const WITH_NAME = "name: 'n8n-nodes-base.example'";
const WITH_VERSION = 'version: 1';
const WITH_PROPERTIES = 'properties: []';

function sourceWith(fields: string): string {
  return `class ExampleNode { description = { ${fields} }; }`;
}

const VALID_SOURCE = sourceWith(
  `${WITH_NAME}, version: [2, 1], properties: [{ name: 'zeta' }, { name: 'alpha' }, { name: 'zeta' }]`,
);

function single(source: string, limits?: Partial<ExtractionLimits>): Extraction {
  const { receipt, files } = fixture({ 'dist/example.node.js': source });
  return extractMetadata(receipt, files, limits);
}

function rejectionOf(source: string, limits?: Partial<ExtractionLimits>) {
  const result = single(source, limits);
  expect(result.candidates).toEqual([]);
  expect(result.rejected).toHaveLength(1);
  return result.rejected[0]!;
}

function expectCandidate(result: Extraction): MetadataCandidate {
  expect(result.rejected).toEqual([]);
  expect(result.candidates).toHaveLength(1);
  return result.candidates[0]!;
}

function versionsOf(literal: string): readonly string[] {
  return expectCandidate(single(sourceWith(`${WITH_NAME}, version: ${literal}, ${WITH_PROPERTIES}`))).versions;
}

describe('DEFAULT_EXTRACTION_LIMITS', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_EXTRACTION_LIMITS).toEqual({
      maxFiles: 5_000,
      maxAggregateBytes: 64 * 1024 * 1024,
      maxFileBytes: 16 * 1024 * 1024,
      maxNodesPerFile: 200_000,
      maxConstantsPerFile: 1_024,
      maxLiteralDepth: 32,
      maxScalarUnits: 100_000,
    });
  });
});

describe('extractMetadata success', () => {
  it('extracts a literal class property description deterministically', () => {
    const { receipt, files } = fixture({ 'dist/example.node.js': VALID_SOURCE });
    const result = extractMetadata(receipt, files);
    expect(result).toEqual({
      candidates: [{
        schemaVersion: '1',
        receiptDigest: sourceReceiptDigest(receipt),
        sourcePath: 'dist/example.node.js',
        nodeType: 'n8n-nodes-base.example',
        versions: ['1.0.0', '2.0.0'],
        parameters: ['alpha', 'zeta'],
        diagnostics: [],
      }],
      rejected: [],
    });
  });

  it('accepts a constructor assignment as the description', () => {
    const source = [
      'class ExampleNode {',
      '  constructor() {',
      `    this.description = { ${WITH_NAME}, ${WITH_VERSION}, ${WITH_PROPERTIES} };`,
      '  }',
      '}',
    ].join('\n');
    const candidate = expectCandidate(single(source));
    expect(candidate.nodeType).toBe('n8n-nodes-base.example');
    expect(candidate.versions).toEqual(['1.0.0']);
    expect(candidate.parameters).toEqual([]);
  });

  it('resolves a top-level constant object used as the description', () => {
    const source = [
      `const DESCRIPTION = { ${WITH_NAME}, version: 3, properties: [{ name: 'b' }, { name: 'a' }] };`,
      'class ExampleNode { description = DESCRIPTION; }',
    ].join('\n');
    const candidate = expectCandidate(single(source));
    expect(candidate.versions).toEqual(['3.0.0']);
    expect(candidate.parameters).toEqual(['a', 'b']);
  });

  it('resolves parenthesized literal values and follows a const version array', () => {
    const source = [
      'const VERSIONS = [3, 1];',
      `class ExampleNode { description = ({ ${WITH_NAME}, version: (VERSIONS), properties: ([]) }); }`,
    ].join('\n');
    const candidate = expectCandidate(single(source));
    expect(candidate.versions).toEqual(['1.0.0', '3.0.0']);
    expect(candidate.parameters).toEqual([]);
  });

  it('resolves constant references and nested constants for versions', () => {
    const direct = [
      'const VERSION = 3;',
      `class ExampleNode { description = { ${WITH_NAME}, version: VERSION, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(expectCandidate(single(direct)).versions).toEqual(['3.0.0']);

    const nested = [
      'const VERSION = SECOND;',
      'const SECOND = 4;',
      `class ExampleNode { description = { ${WITH_NAME}, version: VERSION, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(expectCandidate(single(nested)).versions).toEqual(['4.0.0']);
  });

  it('sorts parameters by UTF-16 code units and dedupes them', () => {
    const fields = [
      WITH_NAME,
      WITH_VERSION,
      "properties: [{ name: 'Zeta' }, { name: 'alpha' }, { name: 'zeta' }, { name: 'alpha' }]",
    ].join(', ');
    expect(expectCandidate(single(sourceWith(fields))).parameters).toEqual(['Zeta', 'alpha', 'zeta']);
  });

  it('accepts a description without a properties member', () => {
    const candidate = expectCandidate(single(sourceWith(`${WITH_NAME}, ${WITH_VERSION}`)));
    expect(candidate.parameters).toEqual([]);
    expect(candidate.diagnostics).toEqual([]);
  });

  it('ignores unrelated description members without evaluating them', () => {
    const source = [
      'function make() { throw new Error("must not run"); }',
      'class ExampleNode {',
      '  description = {',
      '    ...{ subtitle: make(), inputs: make() },',
      '    get subtitle() { throw new Error("must not run"); },',
      '    subtitle: make(),',
      '    inputs: make(),',
      '    outputs: SOME.namespace.expression,',
      '    credentials: () => 1,',
      `    ${WITH_NAME},`,
      '    version: 1,',
      "    properties: [{ name: 'alpha', displayName: 'Alpha', type: 'string', default: make() }],",
      '  };',
      '}',
    ].join('\n');
    const candidate = expectCandidate(single(source));
    expect(candidate.parameters).toEqual(['alpha']);
    expect(candidate.diagnostics).toEqual([]);
  });

  it('extracts multiple distinct descriptions from one file', () => {
    const source = [
      `class First { description = { name: 'n8n-nodes-base.first', ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
      `class Second { description = { name: 'n8n-nodes-base.second', version: 2, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    const result = single(source);
    expect(result.rejected).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.nodeType))
      .toEqual(['n8n-nodes-base.first', 'n8n-nodes-base.second']);
  });

  it('orders candidates within one file by node type', () => {
    const source = [
      `class Zebra { description = { name: 'n8n-nodes-base.zeta', ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
      `class Alpha { description = { name: 'n8n-nodes-base.alpha', ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    const { receipt, files } = fixture({ 'dist/example.node.js': source });
    const result = extractMetadata(receipt, files);
    expect(result.rejected).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.nodeType))
      .toEqual(['n8n-nodes-base.alpha', 'n8n-nodes-base.zeta']);
    expect(validateExtraction(result, receipt)).toEqual({ ok: true, extraction: result });
  });

  it('produces byte-identical JSON for the same inputs and sorts candidates by source path', () => {
    const sources = {
      'dist/b.node.js': sourceWith("name: 'n8n-nodes-base.b', version: 2, properties: []"),
      'dist/a.node.js': sourceWith("name: 'n8n-nodes-base.a', version: 1, properties: []"),
    };
    const firstFixture = fixture(sources);
    const secondFixture = fixture(sources);
    const first = extractMetadata(firstFixture.receipt, firstFixture.files);
    const second = extractMetadata(secondFixture.receipt, secondFixture.files);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.candidates.map((candidate) => candidate.sourcePath))
      .toEqual(['dist/a.node.js', 'dist/b.node.js']);
  });
});

describe('version canonicalization', () => {
  it('renders numeric versions as canonical semver strings', () => {
    expect(versionsOf('2')).toEqual(['2.0.0']);
    expect(versionsOf('2.1')).toEqual(['2.1.0']);
    expect(versionsOf('2.0')).toEqual(['2.0.0']);
  });

  it('dedupes by canonical string and sorts numerically ascending', () => {
    expect(versionsOf('[10, 2.1, 2, 2.1, 2.0]')).toEqual(['2.0.0', '2.1.0', '10.0.0']);
    expect(versionsOf('[2, 2.0]')).toEqual(['2.0.0']);
  });

  it('rejects negative, exponent-form, over-precise, and non-finite versions', () => {
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: -2, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: 1e3, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: [1, 2e1], ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: 1.234, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: 1e400, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
  });
});

describe('parameters and top-level spreads', () => {
  it('marks a dynamic properties member as PARTIAL_PARAMETERS without rejecting the file', () => {
    const candidate = expectCandidate(
      single(sourceWith(`${WITH_NAME}, ${WITH_VERSION}, properties: makeProperties()`)),
    );
    expect(candidate.parameters).toEqual([]);
    expect(candidate.diagnostics).toEqual(['PARTIAL_PARAMETERS']);
  });

  it('marks non-array and non-object property elements as PARTIAL_PARAMETERS', () => {
    const nonArray = expectCandidate(single(sourceWith(`${WITH_NAME}, ${WITH_VERSION}, properties: {}`)));
    expect(nonArray.parameters).toEqual([]);
    expect(nonArray.diagnostics).toEqual(['PARTIAL_PARAMETERS']);

    const mixed = expectCandidate(single(sourceWith([
      WITH_NAME,
      WITH_VERSION,
      "properties: [{ name: 'alpha' }, 'url', {}, { name: '' }, null, { name: 'beta' }]",
    ].join(', '))));
    expect(mixed.parameters).toEqual(['alpha', 'beta']);
    expect(mixed.diagnostics).toEqual(['PARTIAL_PARAMETERS']);
  });

  it('uses explicit element names and ignores unrelated element members', () => {
    const candidate = expectCandidate(single(sourceWith([
      WITH_NAME,
      WITH_VERSION,
      "properties: [{ name: 'alpha', default: make(), type: 'string' }, { name: 'beta', options: OTHER }]",
    ].join(', '))));
    expect(candidate.parameters).toEqual(['alpha', 'beta']);
    expect(candidate.diagnostics).toEqual([]);
  });

  it('uses an element name after an element spread and skips one followed by a spread', () => {
    const candidate = expectCandidate(single(sourceWith([
      WITH_NAME,
      WITH_VERSION,
      "properties: [{ ...BASE, name: 'gamma' }, { name: 'alpha' }, { name: 'delta', ...EXTRA }]",
    ].join(', '))));
    expect(candidate.parameters).toEqual(['alpha', 'gamma']);
    expect(candidate.diagnostics).toEqual(['PARTIAL_PARAMETERS']);
  });

  it('skips elements after an array spread', () => {
    const candidate = expectCandidate(single(sourceWith([
      WITH_NAME,
      WITH_VERSION,
      "properties: [{ name: 'a' }, ...REST, { name: 'b' }]",
    ].join(', '))));
    expect(candidate.parameters).toEqual(['a']);
    expect(candidate.diagnostics).toEqual(['PARTIAL_PARAMETERS']);
  });

  it('treats a properties getter as dynamic partial parameters', () => {
    const source = [
      'class ExampleNode { description = {',
      `${WITH_NAME}, ${WITH_VERSION},`,
      'get properties() { throw new Error("must not run"); },',
      '}; }',
    ].join('\n');
    expect(() => single(source)).not.toThrow();
    const candidate = expectCandidate(single(source));
    expect(candidate.parameters).toEqual([]);
    expect(candidate.diagnostics).toEqual(['PARTIAL_PARAMETERS']);
  });

  it('rejects a leading unresolved spread that may provide scoped fields', () => {
    const source = sourceWith(`...importedDescription, ${WITH_NAME}, ${WITH_VERSION}`);
    expect(rejectionOf(source).reason).toBe('DYNAMIC_DESCRIPTION');
  });

  it('accepts a benign resolvable leading spread with no scoped fields', () => {
    const source = [
      "const BASE = { type: 'hidden', defaults: { retries: 1 } };",
      `class ExampleNode { description = { ...BASE, ${WITH_NAME}, ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(expectCandidate(single(source)).nodeType).toBe('n8n-nodes-base.example');
  });

  it('merges a resolvable leading spread and keeps later explicit keys', () => {
    const source = [
      "const BASE = { version: 2, properties: [{ name: 'fromBase' }] };",
      `class ExampleNode { description = { ...BASE, ${WITH_NAME}, version: 1 }; }`,
    ].join('\n');
    const candidate = expectCandidate(single(source));
    expect(candidate.versions).toEqual(['1.0.0']);
    expect(candidate.parameters).toEqual(['fromBase']);
  });

  it('rejects a spread after a scoped key unless its source is a resolvable const object', () => {
    const unresolvable = sourceWith(`${WITH_NAME}, ...UNKNOWN_SPREAD, ${WITH_VERSION}, ${WITH_PROPERTIES}`);
    expect(rejectionOf(unresolvable).reason).toBe('DYNAMIC_DESCRIPTION');

    const resolvable = [
      "const BASE = { version: 2, properties: [{ name: 'fromBase' }] };",
      `class ExampleNode { description = { ${WITH_NAME}, ...BASE }; }`,
    ].join('\n');
    const candidate = expectCandidate(single(resolvable));
    expect(candidate.versions).toEqual(['2.0.0']);
    expect(candidate.parameters).toEqual(['fromBase']);

    const laterExplicitWins = [
      "const BASE = { version: 2, properties: [{ name: 'fromBase' }] };",
      `class ExampleNode { description = { ${WITH_NAME}, ...BASE, version: 3 }; }`,
    ].join('\n');
    expect(expectCandidate(single(laterExplicitWins)).versions).toEqual(['3.0.0']);
  });
});

describe('extractMetadata rejections', () => {
  it('rejects a non-object receipt with INVALID_RECEIPT', () => {
    const result = extractMetadata(null as unknown as SourceReceipt, new Map());
    expect(result).toEqual({
      candidates: [],
      rejected: [{ path: '<receipt>', reason: 'INVALID_RECEIPT' }],
    });
  });

  it('rejects an unsafe receipt path with INVALID_RECEIPT', () => {
    const unsafe = {
      ...fixture({ 'dist/example.node.js': VALID_SOURCE }).receipt,
      files: [{ path: '../escape.node.js', sha256: sha256(encoder.encode(VALID_SOURCE)) }],
    } as SourceReceipt;
    expect(extractMetadata(unsafe, new Map())).toEqual({
      candidates: [],
      rejected: [{ path: '<receipt>', reason: 'INVALID_RECEIPT' }],
    });
  });

  it('rejects a receipt over the file-count limit with INVALID_RECEIPT', () => {
    const { receipt, files } = fixture({
      'dist/a.node.js': sourceWith(`${WITH_NAME}, ${WITH_VERSION}, ${WITH_PROPERTIES}`),
      'dist/b.node.js': sourceWith(`${WITH_NAME}, ${WITH_VERSION}, ${WITH_PROPERTIES}`),
    });
    expect(extractMetadata(receipt, files, { maxFiles: 1 })).toEqual({
      candidates: [],
      rejected: [{ path: '<receipt>', reason: 'INVALID_RECEIPT' }],
    });
  });

  it('prefixes file-map validation failures with RECEIPT_', () => {
    const { receipt } = fixture({ 'dist/example.node.js': VALID_SOURCE });
    const tampered = new Map<string, Uint8Array>([['dist/example.node.js', encoder.encode('tampered')]]);
    expect(extractMetadata(receipt, tampered)).toEqual({
      candidates: [],
      rejected: [{ path: 'dist/example.node.js', reason: 'RECEIPT_HASH_MISMATCH' }],
    });

    const withExtra = new Map(tampered);
    withExtra.set('dist/example.node.js', toBytes(VALID_SOURCE));
    withExtra.set('dist/extra.node.js', encoder.encode(''));
    expect(extractMetadata(receipt, withExtra)).toEqual({
      candidates: [],
      rejected: [{ path: 'dist/extra.node.js', reason: 'RECEIPT_UNEXPECTED_FILE' }],
    });
  });

  it('rejects a missing file and a non-byte map value', () => {
    const { receipt, files } = fixture({ 'dist/example.node.js': VALID_SOURCE });
    const missing = new Map(files);
    missing.delete('dist/example.node.js');
    expect(extractMetadata(receipt, missing)).toEqual({
      candidates: [],
      rejected: [{ path: 'dist/example.node.js', reason: 'RECEIPT_MISSING_FILE' }],
    });

    const wrongType = new Map([['dist/example.node.js', 'not bytes']]) as unknown as ReadonlyMap<string, Uint8Array>;
    expect(extractMetadata(receipt, wrongType)).toEqual({
      candidates: [],
      rejected: [{ path: 'dist/example.node.js', reason: 'RECEIPT_INVALID_FILE_CONTENT' }],
    });
  });

  it('rejects invalid UTF-8 without throwing', () => {
    const { receipt, files } = fixture({ 'dist/bad.node.js': new Uint8Array([0x63, 0x6c, 0xc3, 0x28]) });
    expect(() => extractMetadata(receipt, files)).not.toThrow();
    expect(extractMetadata(receipt, files)).toEqual({
      candidates: [],
      rejected: [{ path: 'dist/bad.node.js', reason: 'INVALID_UTF8' }],
    });
  });

  it('rejects a file without a description', () => {
    expect(rejectionOf('class ExampleNode {}').reason).toBe('NO_DESCRIPTION');
  });

  it('rejects a non-object description after resolution', () => {
    const source = [
      "const DESCRIPTION = 'not-an-object';",
      'class ExampleNode { description = DESCRIPTION; }',
    ].join('\n');
    expect(rejectionOf(source).reason).toBe('DYNAMIC_DESCRIPTION');
  });

  it('rejects a call-based description without executing it', () => {
    const source = [
      'function makeDescription() { throw new Error("must not run"); }',
      'class ExampleNode { description = makeDescription(); }',
    ].join('\n');
    expect(() => single(source)).not.toThrow();
    expect(rejectionOf(source).reason).toBe('DYNAMIC_DESCRIPTION');
  });

  it('rejects a getter description without invoking it', () => {
    const source = [
      'class ExampleNode {',
      '  get description() { throw new Error("must not run"); }',
      '}',
    ].join('\n');
    expect(() => single(source)).not.toThrow();
    expect(rejectionOf(source).reason).toBe('DYNAMIC_DESCRIPTION');
  });

  it('rejects a computed description key as DYNAMIC_DESCRIPTION', () => {
    const source = [
      "const KEY = 'name';",
      `class ExampleNode { description = { [KEY]: 'n8n-nodes-base.computed', ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(source).reason).toBe('DYNAMIC_DESCRIPTION');
  });

  it('rejects a dynamic name without executing it', () => {
    const call = [
      'function makeName() { throw new Error("must not run"); }',
      `class ExampleNode { description = { name: makeName(), ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(call).reason).toBe('DYNAMIC_NAME');

    const getter = [
      'class ExampleNode { description = {',
      `get name() { throw new Error("must not run"); }, ${WITH_VERSION}, ${WITH_PROPERTIES}`,
      '}; }',
    ].join('\n');
    expect(rejectionOf(getter).reason).toBe('DYNAMIC_NAME');

    expect(rejectionOf(sourceWith(`name: UNKNOWN, ${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason)
      .toBe('DYNAMIC_NAME');
  });

  it('rejects a dynamic version without executing it', () => {
    const source = [
      'function computeVersion() { return 1; }',
      `class ExampleNode { description = { ${WITH_NAME}, version: computeVersion(), ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(source).reason).toBe('DYNAMIC_VERSION');

    const cycle = [
      'const A = B;',
      'const B = A;',
      `class ExampleNode { description = { ${WITH_NAME}, version: A, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(cycle).reason).toBe('DYNAMIC_VERSION');
  });

  it('rejects a missing or invalid name', () => {
    expect(rejectionOf(sourceWith(`${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason).toBe('INVALID_NAME');
    expect(rejectionOf(sourceWith(`name: '', ${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason).toBe('INVALID_NAME');
    expect(rejectionOf(sourceWith(`name: 'bad\\u0000name', ${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_NAME');
    expect(rejectionOf(sourceWith(`name: '${'n'.repeat(201)}', ${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_NAME');
  });

  it('rejects a lone-surrogate description name without relying on the validator', () => {
    for (const escape of ['\\uD800', '\\uDC00', '\\uD83D']) {
      expect(rejectionOf(sourceWith(`name: 'n8n-nodes-base.${escape}', ${WITH_VERSION}, ${WITH_PROPERTIES}`)).reason)
        .toBe('INVALID_NAME');
    }
  });

  it('accepts valid surrogate pairs and ordinary astral characters in a name', () => {
    const source = sourceWith(`name: 'n8n-nodes-base.\\uD83D\\uDE00', ${WITH_VERSION}, ${WITH_PROPERTIES}`);
    expect(expectCandidate(single(source)).nodeType).toBe('n8n-nodes-base.\u{1F600}');
  });

  it('accepts a name at the 200 code-unit bound', () => {
    const name = 'n'.repeat(200);
    expect(expectCandidate(single(sourceWith(`name: '${name}', ${WITH_VERSION}, ${WITH_PROPERTIES}`))).nodeType)
      .toBe(name);
  });

  it('rejects a missing, empty, or invalid version', () => {
    expect(rejectionOf(sourceWith(`${WITH_NAME}, ${WITH_PROPERTIES}`)).reason).toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: [], ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: [1, -2], ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
    expect(rejectionOf(sourceWith(`${WITH_NAME}, version: ['1'], ${WITH_PROPERTIES}`)).reason)
      .toBe('INVALID_VERSION');
  });

  it('rejects duplicate (sourcePath, nodeType) identities in one file', () => {
    const source = [
      `class First { description = { name: 'n8n-nodes-base.duplicate', ${WITH_VERSION}, ${WITH_PROPERTIES} }; }`,
      `class Second { description = { name: 'n8n-nodes-base.duplicate', version: 2, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(source).reason).toBe('DUPLICATE_IDENTITY');
  });

  it('sorts rejections by path and then reason', () => {
    const { receipt, files } = fixture({
      'dist/b.node.js': 'class B {}',
      'dist/a.node.js': 'class A {}',
    });
    const result = extractMetadata(receipt, files);
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([
      { path: 'dist/a.node.js', reason: 'NO_DESCRIPTION' },
      { path: 'dist/b.node.js', reason: 'NO_DESCRIPTION' },
    ]);
  });
});

describe('limits', () => {
  it('rejects files past maxNodesPerFile', () => {
    expect(rejectionOf(VALID_SOURCE, { maxNodesPerFile: 5 }).reason).toBe('NODE_LIMIT');
  });

  it('rejects more constants than maxConstantsPerFile', () => {
    const source = [
      'const A = 1;',
      'const B = 2;',
      `class ExampleNode { description = { ${WITH_NAME}, version: A, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(source, { maxConstantsPerFile: 1 }).reason).toBe('CONSTANT_LIMIT');
  });

  it('counts decoded string code units cumulatively against maxScalarUnits', () => {
    // VALID_SOURCE: name (22) + parameter names zeta/alpha/zeta (4+5+4) = 35 units.
    const exact = expectCandidate(single(VALID_SOURCE, { maxScalarUnits: 35 }));
    expect(exact.diagnostics).toEqual([]);
    expect(rejectionOf(VALID_SOURCE, { maxScalarUnits: 34 }).reason).toBe('SCALAR_LIMIT');
  });

  it('rejects a 200k string past maxScalarUnits', () => {
    const big = 'x'.repeat(200_000);
    expect(rejectionOf(sourceWith(`name: '${big}', ${WITH_VERSION}, ${WITH_PROPERTIES}`), {
      maxScalarUnits: 5,
    }).reason).toBe('SCALAR_LIMIT');
  });

  it('does not count ignored string members', () => {
    const big = 'x'.repeat(200_000);
    const source = sourceWith(`${WITH_NAME}, ${WITH_VERSION}, ${WITH_PROPERTIES}, subtitle: '${big}'`);
    expect(expectCandidate(single(source, { maxScalarUnits: 35 })).nodeType).toBe('n8n-nodes-base.example');
  });

  it('rejects nesting and constant chains past maxLiteralDepth', () => {
    const chain = [
      'const A = B;',
      'const B = C;',
      'const C = 5;',
      `class ExampleNode { description = { ${WITH_NAME}, version: A, ${WITH_PROPERTIES} }; }`,
    ].join('\n');
    expect(rejectionOf(chain, { maxLiteralDepth: 1 }).reason).toBe('NESTING_LIMIT');

    const nested = sourceWith(`name: [[[ 'x' ]]], ${WITH_VERSION}, ${WITH_PROPERTIES}`);
    expect(rejectionOf(nested, { maxLiteralDepth: 2 }).reason).toBe('NESTING_LIMIT');
  });

  it('rejects a 700-deep literal without throwing', () => {
    const deep = `${'['.repeat(700)}1${']'.repeat(700)}`;
    const source = sourceWith(`${WITH_NAME}, version: ${deep}, ${WITH_PROPERTIES}`);
    expect(() => single(source)).not.toThrow();
    const result = single(source);
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(['NESTING_LIMIT', 'PARSE_DEPTH']).toContain(result.rejected[0]!.reason);
  });

  it('falls back to defaults for NaN, Infinity, and non-integer limit overrides', () => {
    const candidate = expectCandidate(single(VALID_SOURCE, {
      maxFiles: 1.5,
      maxAggregateBytes: Number.NaN,
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxNodesPerFile: Number.NaN,
      maxConstantsPerFile: Number.NEGATIVE_INFINITY,
      maxLiteralDepth: Number.NaN,
      maxScalarUnits: Number.POSITIVE_INFINITY,
    }));
    expect(candidate.nodeType).toBe('n8n-nodes-base.example');

    const negative = expectCandidate(single(VALID_SOURCE, { maxScalarUnits: -1, maxLiteralDepth: -5 }));
    expect(negative.versions).toEqual(['1.0.0', '2.0.0']);
  });
});
