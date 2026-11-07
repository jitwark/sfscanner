import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  validateExtraction,
  validateMetadataCandidate,
  type CandidateReason,
  type CandidateValidation,
  type ExtractionValidation,
} from './candidate-validator.js';
import { extractMetadata, type Extraction, type MetadataCandidate } from './metadata-extractor.js';
import { sourceReceiptDigest, validateSourceReceipt, type SourceReceipt } from './source-receipt.js';

const RECEIPT_INPUT = {
  packageName: 'n8n-nodes-base',
  packageVersion: '2.15.1',
  artifactSha256: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  licenseReceiptDigest: 'c'.repeat(64),
  files: [
    { path: 'dist/a.node.js', sha256: 'd'.repeat(64) },
    { path: 'dist/b.node.js', sha256: 'e'.repeat(64) },
    { path: 'dist/c.node.js', sha256: 'f'.repeat(64) },
  ],
};

const RECEIPT: SourceReceipt = (() => {
  const result = validateSourceReceipt(RECEIPT_INPUT);
  if (!result.ok) throw new Error(`fixture receipt invalid: ${result.reason}`);
  return result.receipt;
})();
const RECEIPT_DIGEST = sourceReceiptDigest(RECEIPT);

const BASE: Readonly<Record<string, unknown>> = {
  schemaVersion: '1',
  receiptDigest: RECEIPT_DIGEST,
  sourcePath: 'dist/a.node.js',
  nodeType: 'n8n-nodes-base.a',
  versions: ['1.0.0'],
  parameters: [],
  diagnostics: [],
};

const candidateWith = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> =>
  ({ ...BASE, ...overrides });

const at = (sourcePath: string, nodeType: string): Record<string, unknown> =>
  candidateWith({ sourcePath, nodeType });

const extractionWith = (
  candidates: readonly unknown[],
  rejected: readonly unknown[] = [],
): Record<string, unknown> => ({ candidates, rejected });

const orderedParameters = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `p${String(index).padStart(4, '0')}`);

const orderedDiagnostics = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `D${String(index).padStart(2, '0')}`);

const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');

function expectCandidateRejection(
  overrides: Readonly<Record<string, unknown>>,
  reason: CandidateReason,
  field?: string,
) {
  return expectRejectionOf(candidateWith(overrides), reason, field);
}

function expectRejectionOf(input: unknown, reason: CandidateReason, field?: string) {
  const result = validateMetadataCandidate(input, RECEIPT);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.reason).toBe(reason);
  if (field !== undefined) expect(result.field).toBe(field);
  return result;
}

function expectExtractionRejection(input: unknown, reason: CandidateReason) {
  let result: ExtractionValidation | undefined;
  expect(() => { result = validateExtraction(input, RECEIPT); }).not.toThrow();
  expect(result!.ok).toBe(false);
  if (result!.ok) throw new Error('expected rejection');
  expect(result!.reason).toBe(reason);
  return result!;
}

describe('validateMetadataCandidate acceptance', () => {
  it('accepts a valid candidate, returns it unchanged, and repeats the result', () => {
    const input = candidateWith({ versions: ['1.0.0', '2.0.0', '10.0.0'], parameters: ['alpha', 'zeta'] });
    const snapshot = structuredClone(input);
    const result = validateMetadataCandidate(input, RECEIPT);
    expect(result).toEqual({ ok: true, candidate: input });
    if (!result.ok) return;
    expect(result.candidate).toBe(input);
    expect(input).toEqual(snapshot);
    expect(validateMetadataCandidate(input, RECEIPT)).toEqual(result);
  });

  it('accepts canonical NFC node types and rejects the NFD spelling', () => {
    expect(validateMetadataCandidate(candidateWith({ nodeType: 'Café' }), RECEIPT).ok).toBe(true);
    const result = expectCandidateRejection({ nodeType: 'Cafe\u0301' }, 'NON_CANONICAL_UNICODE', 'nodeType');
    expect(result.field).toBe('nodeType');
  });

  it('accepts valid surrogate pairs and ordinary astral characters', () => {
    const result = validateMetadataCandidate(
      candidateWith({ nodeType: 'n8n-nodes-base.\u{1F600}', parameters: ['\u{1D11E}', '\u{1F680}'] }),
      RECEIPT,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a null-prototype record and a plain object alike', () => {
    const nullPrototype = Object.assign(Object.create(null), candidateWith());
    expect(validateMetadataCandidate(nullPrototype, RECEIPT)).toEqual({ ok: true, candidate: nullPrototype });
    expect(validateMetadataCandidate(candidateWith(), RECEIPT).ok).toBe(true);
  });

  it('accepts an extraction whose rejections account for every receipt path', () => {
    const input = extractionWith([], [
      { path: 'dist/a.node.js', reason: 'NO_DESCRIPTION' },
      { path: 'dist/b.node.js', reason: 'NO_DESCRIPTION' },
      { path: 'dist/c.node.js', reason: 'NO_DESCRIPTION' },
    ]);
    const result = validateExtraction(input, RECEIPT);
    expect(result).toEqual({ ok: true, extraction: input });
    if (!result.ok) return;
    expect(result.extraction).toBe(input);
  });
});

describe('validateMetadataCandidate rejection', () => {
  it('rejects malformed roots without throwing', () => {
    for (const root of [null, [], 'x', 42, true, () => ({})]) {
      let result: CandidateValidation | undefined;
      expect(() => { result = validateMetadataCandidate(root, RECEIPT); }).not.toThrow();
      expect(result!.ok).toBe(false);
      if (result!.ok) continue;
      expect(result!.reason).toBe('INVALID_ROOT');
    }
  });

  it('rejects missing and extra candidate fields as invalid roots', () => {
    for (const field of Object.keys(BASE)) {
      const input = candidateWith();
      delete input[field];
      const result = validateMetadataCandidate(input, RECEIPT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('INVALID_ROOT');
    }
    expectCandidateRejection({ extra: true }, 'INVALID_ROOT', 'extra');
  });

  it('rejects accessor properties without invoking them', () => {
    const input = candidateWith();
    Object.defineProperty(input, 'nodeType', {
      get() { throw new Error('getter must not run'); },
      enumerable: true,
      configurable: true,
    });
    expectRejectionOf(input, 'INVALID_ROOT', 'nodeType');
  });

  it('rejects a class instance even when its own fields match the shape', () => {
    class Shape { toJSON(): unknown { return { schemaVersion: '1' }; } }
    expectRejectionOf(Object.assign(new Shape(), candidateWith()), 'INVALID_ROOT');
  });

  it('rejects a class instance without running an inherited toJSON getter', () => {
    class Hostile { get toJSON(): never { throw new Error('prototype getter must not run'); } }
    expectRejectionOf(Object.assign(new Hostile(), candidateWith()), 'INVALID_ROOT');
  });

  it('rejects lone surrogate code units in node types and parameter names', () => {
    for (const nodeType of ['n8n-nodes-base.\uD800', 'n8n-nodes-base.\uDC00', 'n8n-nodes-base.\uD83Dx']) {
      expectCandidateRejection({ nodeType }, 'INVALID_NODE_TYPE', 'nodeType');
    }
    for (const parameters of [['p\uD800'], ['p\uDC00'], ['\uD83D', 'z']]) {
      expectCandidateRejection({ parameters }, 'INVALID_PARAMETER', 'parameters');
    }
  });

  it('rejects a non-canonical schema version', () => {
    expectCandidateRejection({ schemaVersion: '2' }, 'INVALID_SCHEMA_VERSION', 'schemaVersion');
    expectCandidateRejection({ schemaVersion: 1 }, 'INVALID_SCHEMA_VERSION', 'schemaVersion');
  });

  it('rejects a receipt digest that does not match the receipt', () => {
    expectCandidateRejection({ receiptDigest: '0'.repeat(64) }, 'RECEIPT_DIGEST_MISMATCH', 'receiptDigest');
    expectCandidateRejection({ receiptDigest: 7 }, 'RECEIPT_DIGEST_MISMATCH', 'receiptDigest');
  });

  it('rejects source paths outside the receipt', () => {
    expectCandidateRejection({ sourcePath: 'dist/z.node.js' }, 'UNKNOWN_SOURCE_PATH', 'sourcePath');
    expectCandidateRejection({ sourcePath: 'dist' }, 'UNKNOWN_SOURCE_PATH', 'sourcePath');
    expectCandidateRejection({ sourcePath: 7 }, 'UNKNOWN_SOURCE_PATH', 'sourcePath');
  });

  it('rejects invalid node types', () => {
    for (const nodeType of ['', 'n'.repeat(201), 'bad\u0000node', 'tab\there', 7, null]) {
      expectCandidateRejection({ nodeType }, 'INVALID_NODE_TYPE', 'nodeType');
    }
  });

  it('rejects non-canonical Unicode in parameters', () => {
    expectCandidateRejection({ parameters: ['Cafe\u0301'] }, 'NON_CANONICAL_UNICODE', 'parameters');
  });

  it('rejects malformed version strings', () => {
    const values: readonly unknown[] = [
      [], ['1.0'], ['v1.0.0'], ['1.0.0-beta.1'], ['1.0.0 - 2.0.0'], ['^1.0.0'],
      ['-1.0.0'], ['1.0.0.0'], [' 1.0.0'], ['1e0.0.0'], [1], '1.0.0', null,
    ];
    for (const versions of values) {
      expectCandidateRejection({ versions }, 'INVALID_VERSION', 'versions');
    }
    const sparse: string[] = [];
    sparse.length = 1;
    expectCandidateRejection({ versions: sparse }, 'INVALID_VERSION', 'versions');
  });

  it('rejects numerically unsorted versions', () => {
    expectCandidateRejection({ versions: ['2.0.0', '1.0.0'] }, 'UNSORTED_VERSIONS', 'versions');
    expectCandidateRejection({ versions: ['10.0.0', '9.0.0'] }, 'UNSORTED_VERSIONS', 'versions');
  });

  it('rejects duplicate versions', () => {
    expectCandidateRejection({ versions: ['1.0.0', '1.0.0'] }, 'DUPLICATE_VERSION', 'versions');
  });

  it('rejects invalid parameters', () => {
    for (const parameters of [
      ['', 'a'], ['p'.repeat(201)], ['bad\u0000param'], ['control\u009f'], [7], ['dup', 'dup'],
    ]) {
      expectCandidateRejection({ parameters }, 'INVALID_PARAMETER', 'parameters');
    }
    expectCandidateRejection({ parameters: 'alpha' }, 'INVALID_PARAMETER', 'parameters');
  });

  it('rejects unsorted parameters', () => {
    expectCandidateRejection({ parameters: ['beta', 'alpha'] }, 'UNSORTED_PARAMETERS', 'parameters');
  });

  it('rejects too many parameters', () => {
    expectCandidateRejection({ parameters: orderedParameters(513) }, 'TOO_MANY_PARAMETERS', 'parameters');
    expect(validateMetadataCandidate(candidateWith({ parameters: orderedParameters(512) }), RECEIPT).ok).toBe(true);
  });

  it('rejects invalid diagnostics', () => {
    for (const diagnostics of [
      ['partial', 'A'], ['1ABC'], ['A'.repeat(65)], ['B', 'A'], ['A', 'A'],
      orderedDiagnostics(17), [7],
    ]) {
      expectCandidateRejection({ diagnostics }, 'INVALID_DIAGNOSTIC', 'diagnostics');
    }
    expectCandidateRejection({ diagnostics: 'PARTIAL_PARAMETERS' }, 'INVALID_DIAGNOSTIC', 'diagnostics');
  });
});

describe('validateExtraction acceptance', () => {
  it('accepts two ordered candidates and one rejection, and repeats the result', () => {
    const input = extractionWith(
      [
        at('dist/a.node.js', 'n8n-nodes-base.a'),
        at('dist/b.node.js', 'n8n-nodes-base.b'),
      ],
      [{ path: 'dist/c.node.js', reason: 'NO_DESCRIPTION' }],
    );
    const first = validateExtraction(input, RECEIPT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.extraction).toBe(input);
    expect(first.extraction.candidates).toHaveLength(2);
    expect(first.extraction.rejected).toHaveLength(1);
    expect(validateExtraction(input, RECEIPT)).toEqual(first);
    for (const candidate of first.extraction.candidates) {
      expect(validateMetadataCandidate(candidate, RECEIPT).ok).toBe(true);
    }
  });
});

describe('validateExtraction rejection', () => {
  it('rejects malformed roots without throwing', () => {
    for (const root of [null, [], 'x', 42, { candidates: [] }, { rejected: [] }]) {
      expectExtractionRejection(root, 'INVALID_ROOT');
    }
    expectExtractionRejection({ candidates: [], rejected: [], extra: true }, 'INVALID_ROOT');
    expectExtractionRejection({ candidates: 'x', rejected: [] }, 'INVALID_ROOT');
    expectExtractionRejection({ candidates: [], rejected: 'x' }, 'INVALID_ROOT');
  });

  it('rejects getter-bearing candidate objects and elements without throwing', () => {
    const hostile = candidateWith();
    Object.defineProperty(hostile, 'versions', {
      get() { throw new Error('getter must not run'); },
      enumerable: true,
      configurable: true,
    });
    expectExtractionRejection(extractionWith([hostile]), 'INVALID_ROOT');

    const candidates: unknown[] = [];
    Object.defineProperty(candidates, '0', {
      get() { throw new Error('element getter must not run'); },
      enumerable: true,
    });
    expectExtractionRejection(extractionWith(candidates), 'INVALID_ROOT');
  });

  it('rejects sparse candidate arrays as invalid roots', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectExtractionRejection(extractionWith(sparse), 'INVALID_ROOT');
  });

  it('rejects an extraction that leaves a receipt path unaccounted for', () => {
    const result = expectExtractionRejection(
      extractionWith([at('dist/a.node.js', 'n8n-nodes-base.a')], [
        { path: 'dist/b.node.js', reason: 'NO_DESCRIPTION' },
      ]),
      'INVALID_ROOT',
    );
    expect(result.path).toBe('dist/c.node.js');
  });

  it('propagates a candidate failure', () => {
    const input = extractionWith([candidateWith({ receiptDigest: '0'.repeat(64) })]);
    const result = expectExtractionRejection(input, 'RECEIPT_DIGEST_MISMATCH');
    expect(result.field).toBe('receiptDigest');
  });

  it('rejects duplicate candidate identities', () => {
    const result = expectExtractionRejection(
      extractionWith([at('dist/a.node.js', 'n8n-nodes-base.a'), at('dist/a.node.js', 'n8n-nodes-base.a')]),
      'DUPLICATE_CANDIDATE',
    );
    expect(result.path).toBe('dist/a.node.js');
  });

  it('rejects unsorted candidates', () => {
    expectExtractionRejection(
      extractionWith([at('dist/b.node.js', 'n8n-nodes-base.b'), at('dist/a.node.js', 'n8n-nodes-base.a')]),
      'UNSORTED_CANDIDATES',
    );
    expectExtractionRejection(
      extractionWith([at('dist/a.node.js', 'n8n-nodes-base.b'), at('dist/a.node.js', 'n8n-nodes-base.a')]),
      'UNSORTED_CANDIDATES',
    );
  });

  it('rejects invalid rejection entries', () => {
    for (const entry of [
      null,
      'NO_DESCRIPTION',
      { path: 'dist/c.node.js' },
      { reason: 'NO_DESCRIPTION' },
      { path: 'dist/c.node.js', reason: 'lowercase' },
      { path: 'dist/c.node.js', reason: 7 },
      { path: 'dist/c.node.js', reason: 'NO_DESCRIPTION', extra: true },
    ]) {
      expectExtractionRejection(extractionWith([], [entry]), 'INVALID_REJECTION');
    }
  });

  it('rejects rejections for paths outside the receipt', () => {
    expectExtractionRejection(
      extractionWith([], [{ path: 'dist/z.node.js', reason: 'NO_DESCRIPTION' }]),
      'UNKNOWN_REJECTED_PATH',
    );
  });

  it('rejects duplicate rejections', () => {
    const entry = { path: 'dist/c.node.js', reason: 'NO_DESCRIPTION' };
    expectExtractionRejection(extractionWith([], [entry, { ...entry }]), 'DUPLICATE_REJECTION');
  });

  it('rejects two differently-reasoned rejections for one path', () => {
    expectExtractionRejection(
      extractionWith([], [
        { path: 'dist/c.node.js', reason: 'INVALID_UTF8' },
        { path: 'dist/c.node.js', reason: 'NO_DESCRIPTION' },
      ]),
      'DUPLICATE_REJECTION',
    );
  });

  it('rejects unsorted rejections', () => {
    expectExtractionRejection(
      extractionWith([], [
        { path: 'dist/c.node.js', reason: 'NO_DESCRIPTION' },
        { path: 'dist/b.node.js', reason: 'INVALID_NAME' },
      ]),
      'INVALID_REJECTION',
    );
  });

  it('rejects results that both accept and reject the same path', () => {
    const result = expectExtractionRejection(
      extractionWith([at('dist/a.node.js', 'n8n-nodes-base.a')], [
        { path: 'dist/a.node.js', reason: 'NO_DESCRIPTION' },
      ]),
      'OVERLAPPING_RESULT',
    );
    expect(result.path).toBe('dist/a.node.js');
  });
});

describe('validator compatibility with extracted shapes', () => {
  it('accepts a real extraction result for a one-file receipt', () => {
    const source = "class ExampleNode { description = { name: 'n8n-nodes-base.example', version: 1, properties: [{ name: 'alpha' }] }; }";
    const files = new Map([['dist/a.node.js', new TextEncoder().encode(source)]]);
    const receipt = (() => {
      const result = validateSourceReceipt({
        ...RECEIPT_INPUT,
        files: [{ path: 'dist/a.node.js', sha256: sha256(files.get('dist/a.node.js')!) }],
      });
      if (!result.ok) throw new Error(`fixture receipt invalid: ${result.reason}`);
      return result.receipt;
    })();
    const extraction: Extraction = extractMetadata(receipt, files);
    const result = validateExtraction(extraction, receipt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [candidate] = result.extraction.candidates as readonly MetadataCandidate[];
    expect(candidate?.nodeType).toBe('n8n-nodes-base.example');
  });
});
