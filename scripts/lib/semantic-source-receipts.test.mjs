import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SemanticSourceReceiptError,
  documentedRecords,
  loadSemanticSourceReceipts,
  undocumentedRecords,
  verifySemanticSourceReceipts,
} from './semantic-source-receipts.mjs';

/**
 * B1a — the semantic source receipts bind real upstream files by SHA-256.
 *
 * Two layers do different jobs and the tests pin both:
 *   - the loader enforces *shape* (field presence, lowercase 64-hex digests,
 *     https URLs, duplicate/empty rules) — it never sees the upstream bytes;
 *   - the verifier enforces *content* (hash of the bytes it is given), and it
 *     records SKIPPED rather than a verdict when the caller injects no bytes.
 */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BYTES_A = Buffer.from('module.exports = 1;\n');
const BYTES_B = Buffer.from('module.exports = 2;\n');
const PROVIDED = { 'dist/a.js': BYTES_A, 'dist/b.js': BYTES_B };

function fixtureDocument(overrides = {}) {
  return {
    schemaVersion: 'semantic-source-receipts-v1',
    note: 'fixture receipt for unit tests',
    packages: [
      {
        package: 'pkg-a',
        version: '1.0.0',
        registry: 'https://registry.npmjs.org',
        tarballUrl: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
        tarballSha256: sha256(Buffer.from('pkg-a tarball')),
        distIntegrity: `sha512-${'A'.repeat(86)}==`,
        fetchedAt: '2026-10-17',
        files: [
          { path: 'dist/a.js', bytes: BYTES_A.length, sha256: sha256(BYTES_A) },
          { path: 'dist/b.js', bytes: BYTES_B.length, sha256: sha256(BYTES_B) },
        ],
      },
    ],
    documentsRecords: { 'demo.record': ['pkg-a@1.0.0:dist/a.js'] },
    ...overrides,
  };
}

async function writeDocument(document) {
  const dir = await mkdtemp(join(tmpdir(), 'receipts-'));
  const file = join(dir, 'receipts.json');
  await writeFile(file, JSON.stringify(document, null, 2));
  return file;
}

const loadDocument = (document) => writeDocument(document).then((path) => loadSemanticSourceReceipts({ path }));

describe('loadSemanticSourceReceipts', () => {
  it('loads a well-formed receipt and exposes its packages', async () => {
    const receipts = await loadDocument(fixtureDocument());
    expect(receipts.schemaVersion).toBe('semantic-source-receipts-v1');
    expect(receipts.packages).toHaveLength(1);
    expect(receipts.packages[0].files.map((file) => file.path)).toEqual(['dist/a.js', 'dist/b.js']);
  });

  it('throws the typed error with the documented reason for every malformed shape', async () => {
    const cases = [
      ['MISSING_FIELD', (doc) => { delete doc.note; }],
      ['MISSING_FIELD', (doc) => { delete doc.packages[0].files[0].sha256; }],
      ['INVALID_FIELD', (doc) => { doc.packages[0].files[0].bytes = '17'; }],
      ['INVALID_DIGEST', (doc) => { doc.packages[0].files[0].sha256 = doc.packages[0].files[0].sha256.toUpperCase(); }],
      ['INVALID_DIGEST', (doc) => { doc.packages[0].tarballSha256 = '7f4e2a9c'; }],
      ['INVALID_URL', (doc) => { doc.packages[0].tarballUrl = 'http://registry.npmjs.org/pkg-a.tgz'; }],
      ['INVALID_URL', (doc) => { doc.packages[0].registry = 'https://user:pass@registry.npmjs.org'; }],
      ['DUPLICATE_PACKAGE', (doc) => { doc.packages.push(structuredClone(doc.packages[0])); }],
      ['DUPLICATE_FILE', (doc) => { doc.packages[0].files.push(structuredClone(doc.packages[0].files[0])); }],
      ['EMPTY_FILE_LIST', (doc) => { doc.packages[0].files = []; }],
      ['UNKNOWN_FILE_REFERENCE', (doc) => { doc.documentsRecords['demo.record'] = ['pkg-a@1.0.0:dist/missing.js']; }],
    ];
    for (const [reason, mutate] of cases) {
      const document = structuredClone(fixtureDocument());
      mutate(document);
      let error;
      try {
        await loadDocument(document);
      } catch (caught) {
        error = caught;
      }
      expect(error, reason).toBeInstanceOf(SemanticSourceReceiptError);
      expect(error.reason, reason).toBe(reason);
    }
  });
});

describe('verifySemanticSourceReceipts', () => {
  it('fails a file whose digest does not match the bytes, naming the path and both digests', async () => {
    const receipts = await loadDocument(fixtureDocument());
    const tampered = { ...PROVIDED, 'dist/a.js': Buffer.concat([BYTES_A, Buffer.from('tampered')]) };

    const result = verifySemanticSourceReceipts({ receipts, readPackageBytes: () => tampered });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].path).toBe('dist/a.js');
    expect(result.failures[0].message).toContain('dist/a.js');
    expect(result.failures[0].message).toContain(receipts.packages[0].files[0].sha256);
    expect(result.failures[0].message).toContain(sha256(tampered['dist/a.js']));
  });

  it('binds the byte content, so one flipped byte of the same length breaks the receipt', async () => {
    const receipts = await loadDocument(fixtureDocument());
    const flipped = Buffer.from(BYTES_A);
    flipped[9] ^= 0x01;
    expect(flipped.length).toBe(BYTES_A.length);

    const result = verifySemanticSourceReceipts({
      receipts,
      readPackageBytes: () => ({ ...PROVIDED, 'dist/a.js': flipped }),
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.path)).toEqual(['dist/a.js']);
    expect(result.observations.map((observation) => observation.status)).toEqual(['MISMATCH', 'MATCH']);
  });

  it('cannot be passed by a wrong digest that merely has 64-hex syntax: the loader accepts the shape, the verifier rejects the content', async () => {
    const document = fixtureDocument();
    document.packages[0].files[0].sha256 = 'c'.repeat(64);
    const receipts = await loadDocument(document);

    const result = verifySemanticSourceReceipts({ receipts, readPackageBytes: () => PROVIDED });

    expect(result.ok).toBe(false);
    expect(result.failures[0].path).toBe('dist/a.js');
    expect(result.failures[0].expectedSha256).toBe('c'.repeat(64));
    expect(result.failures[0].receivedSha256).toBe(sha256(BYTES_A));
  });

  it('records SKIPPED and neither passes nor fails when no bytes are injected', async () => {
    const receipts = await loadDocument(fixtureDocument());

    const result = verifySemanticSourceReceipts({ receipts, readPackageBytes: () => undefined });

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.observations.map((observation) => observation.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(result.observations.every((observation) => observation.receivedSha256 === null)).toBe(true);
  });

  it('is deterministic: identical inputs produce identical observation order', async () => {
    const receipts = await loadDocument(fixtureDocument());
    const run = () => verifySemanticSourceReceipts({ receipts, readPackageBytes: () => PROVIDED });

    const first = run();
    const second = run();

    expect(first.observations).toEqual(second.observations);
    expect(first.observations.map((observation) => `${observation.path}:${observation.status}`)).toEqual([
      'dist/a.js:MATCH',
      'dist/b.js:MATCH',
    ]);
    expect(first.ok).toBe(true);
  });
});

describe('documentedRecords coverage', () => {
  it('rejects a record whose source digest matches no documented file digest', async () => {
    const receipts = await loadDocument(fixtureDocument());

    expect(documentedRecords(receipts)['demo.record']).toEqual([
      expect.objectContaining({ package: 'pkg-a', version: '1.0.0', path: 'dist/a.js', sha256: sha256(BYTES_A) }),
    ]);
    expect(undocumentedRecords(receipts, [{ semanticId: 'demo.record', sourceDigest: sha256(BYTES_A) }])).toEqual([]);
    expect(undocumentedRecords(receipts, [{ semanticId: 'demo.record', sourceDigest: 'f'.repeat(64) }])).toEqual(['demo.record']);
    expect(undocumentedRecords(receipts, [{ semanticId: 'demo.absent', sourceDigest: sha256(BYTES_A) }])).toEqual(['demo.absent']);
  });
});

describe('committed semantic source receipts', () => {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

  it('documents the production records and the pending noop.passthrough binding with real upstream digests and no placeholder', () => {
    const receipts = loadSemanticSourceReceipts({ root });
    expect(receipts.packages.map((entry) => `${entry.package}@${entry.version}`)).toEqual([
      'n8n-nodes-base@2.15.1',
      '@n8n/n8n-nodes-langchain@2.43.5',
    ]);

    const records = documentedRecords(receipts);
    const semanticIds = Object.keys(records);
    expect(semanticIds).toContain('noop.passthrough');
    for (const [semanticId, refs] of Object.entries(records)) {
      expect(refs.length, semanticId).toBeGreaterThan(0);
      for (const ref of refs) expect(ref.sha256, `${semanticId}:${ref.path}`).toMatch(/^[0-9a-f]{64}$/);
    }

    const serialised = JSON.stringify(receipts);
    expect(serialised).not.toContain('7f4e2a9c7f4e2a9c');
    expect(serialised).not.toContain('a1b2c3d4a1b2c3d4');
  });
});
