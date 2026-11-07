import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuplicateCorpusV2InputBindingError, inventoryCorpusV2Inputs, type CorpusV2InputIdentity, type CorpusV2InputSource } from './corpus-v2-input-inventory.js';

// Every body below is an in-memory fixture — no test touches the private body
// roots. The digest literals were computed with node:crypto outside this file,
// so the module's hashing is anchored to values this suite did not derive.
const encoder = new TextEncoder();
const BODY = encoder.encode('{"nodes":[],"name":"fixture"}');
const BODY_SHA256 = 'bf36e8a67e3d4c54a1024830e99de2558fb81549ef5c2794c90a95670b03b64c';
const NOT_JSON = encoder.encode('not json');
const NOT_JSON_SHA256 = '7ccfa1fbf3940e6f0c0375d87c0f9235a50514e14cb427bdfaf5077987b26ccf';
const WHITESPACED_JSON = encoder.encode('\n\t {"nodes":[]}');
const WHITESPACED_JSON_SHA256 = '8ea27e5100807d80d41cc1ca7aa4e766f4eb667d4cfa938253082e2491d5d806';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const WRONG_SHA256 = '0'.repeat(64);

const APPROVED_ROOT = path.resolve(path.sep, 'approved', 'root');
// Shares the root's string prefix but is not inside it — the sibling case.
const SIBLING_ROOT = path.resolve(path.sep, 'approved', 'root-evil');
const GITHUB_PATH = path.join(APPROVED_ROOT, 'owner', 'repo', 'workflow.json');
const OFFICIAL_FILE = 'official__42_fixture.json';
const OFFICIAL_PATH = path.join(APPROVED_ROOT, OFFICIAL_FILE);
const ORPHAN_PATH = path.join(APPROVED_ROOT, 'official__999_unmapped.json');
const githubIdentity = (overrides: Partial<{ sourceRepo: string; sourceCommit: string; sourcePath: string }> = {}): CorpusV2InputIdentity => ({ kind: 'GITHUB', sourceRepo: 'owner/repo', sourceCommit: 'c'.repeat(40), sourcePath: 'workflow.json', ...overrides });

const entry = (id: string) => ({ id });

const githubSource = (overrides: Partial<CorpusV2InputSource> = {}): CorpusV2InputSource => ({
  entryId: 'entry-github',
  localPath: GITHUB_PATH,
  approvedRoot: APPROVED_ROOT,
  approvalRecord: 'RULING-C1-SOURCES',
  identity: githubIdentity(),
  expectedSha256: null,
  rightsEvidenceRef: 'LICENCE-MIT@owner/repo',
  ...overrides,
});

const officialIdentity = (file: string, templateId = 42): CorpusV2InputIdentity => ({
  kind: 'OFFICIAL_TEMPLATE',
  templateId,
  sourceDir: path.join(APPROVED_ROOT, 'official'),
  file,
});

const officialSource = (overrides: Partial<CorpusV2InputSource> = {}): CorpusV2InputSource => ({
  entryId: 'entry-official',
  localPath: OFFICIAL_PATH,
  approvedRoot: APPROVED_ROOT,
  approvalRecord: 'RULING-C1-SOURCES',
  identity: officialIdentity(OFFICIAL_FILE),
  expectedSha256: null,
  rightsEvidenceRef: 'RULING-1',
  ...overrides,
});

// Reads only from the in-memory map, keyed by the resolved path the inventory
// hands it, and records every call so "never read" is observable.
const readerOf = (...files: readonly (readonly [string, Uint8Array])[]) => {
  const map = Object.fromEntries(files) as Record<string, Uint8Array>;
  const calls: string[] = [];
  return {
    read: (localPath: string): Uint8Array | undefined => {
      calls.push(localPath);
      return map[localPath];
    },
    calls,
  };
};

const onlyRow = (...args: Parameters<typeof inventoryCorpusV2Inputs>) => {
  const inventory = inventoryCorpusV2Inputs(...args);
  expect(inventory.rows).toHaveLength(1);
  return inventory.rows[0]!;
};

describe('inventoryCorpusV2Inputs', () => {
  it('records an available body with its digest, byte length and matching declared/expected identity', () => {
    const files = readerOf([GITHUB_PATH, BODY]);
    const row = onlyRow(
      [entry('entry-github')],
      [githubSource({ expectedSha256: BODY_SHA256, expectedIdentity: githubIdentity() })],
      files.read,
    );
    expect(row).toEqual({
      entryId: 'entry-github', identityKind: 'GITHUB', status: 'AVAILABLE', bodySha256: BODY_SHA256,
      byteLength: BODY.length, sourceCommit: 'c'.repeat(40), sourcePath: 'workflow.json', reasonCode: null,
    });
    expect(files.calls).toEqual([GITHUB_PATH]);
  });

  it('rejects a digest mismatch and records the body it actually found', () => {
    const files = readerOf([GITHUB_PATH, BODY]);
    const row = onlyRow([entry('entry-github')], [githubSource({ expectedSha256: WRONG_SHA256 })], files.read);
    expect(row).toMatchObject({ status: 'REJECTED', reasonCode: 'DIGEST_MISMATCH', bodySha256: BODY_SHA256, byteLength: BODY.length });
  });

  it('refuses the whole inventory when two source rows bind the same entry id', () => {
    const files = readerOf([GITHUB_PATH, BODY]);
    const duplicate = [githubSource(), githubSource({ localPath: path.join(APPROVED_ROOT, 'other.json') })];
    expect(() => inventoryCorpusV2Inputs([entry('entry-github')], duplicate, files.read)).toThrow(DuplicateCorpusV2InputBindingError);
    expect(files.calls).toEqual([]); // rejected before a single read
  });

  it('rejects `..` escapes and sibling prefixes, and accepts paths that resolve back inside', () => {
    const outside = path.resolve(APPROVED_ROOT, '..', 'outside', 'workflow.json');
    const sibling = path.join(SIBLING_ROOT, 'workflow.json');
    const roundabout = path.join(APPROVED_ROOT, 'owner', 'repo', '..', 'repo', 'workflow.json'); // normalizes to GITHUB_PATH
    const files = readerOf([outside, BODY], [sibling, BODY], [GITHUB_PATH, BODY]);
    const rows = inventoryCorpusV2Inputs(
      [entry('entry-outside'), entry('entry-roundabout'), entry('entry-sibling')],
      [
        githubSource({ entryId: 'entry-outside', localPath: outside }),
        githubSource({ entryId: 'entry-roundabout', localPath: roundabout }),
        githubSource({ entryId: 'entry-sibling', localPath: sibling }),
      ],
      files.read,
    ).rows;
    // The sibling shares the root's string prefix: the case a naive startsWith predicate wrongly admits.
    expect(rows.map((row) => [row.entryId, row.status, row.reasonCode])).toEqual([
      ['entry-outside', 'REJECTED', 'PATH_OUTSIDE_APPROVED_ROOT'],
      ['entry-roundabout', 'AVAILABLE', null],
      ['entry-sibling', 'REJECTED', 'PATH_OUTSIDE_APPROVED_ROOT'],
    ]);
    expect(files.calls).toEqual([GITHUB_PATH]); // neither rejected path was read
  });

  it.each<[string, CorpusV2InputSource]>([
    ['a GITHUB identity with a blank repo', githubSource({ identity: githubIdentity({ sourceRepo: '' }) })], ['a GITHUB identity with a blank commit', githubSource({ identity: githubIdentity({ sourceCommit: '  ' }) })],
    ['a GITHUB identity with a blank path', githubSource({ identity: githubIdentity({ sourcePath: '' }) })], ['an OFFICIAL_TEMPLATE identity naming a different file', officialSource({ identity: officialIdentity('official__42_other.json') })],
    ['an OFFICIAL_TEMPLATE identity with templateId 0', officialSource({ identity: officialIdentity(OFFICIAL_FILE, 0) })], ['a declared identity that disagrees with the caller expectation', githubSource({ expectedIdentity: githubIdentity({ sourceCommit: 'd'.repeat(40) }) })],
    ['a declared identity whose kind disagrees with the caller expectation', githubSource({ expectedIdentity: officialIdentity(OFFICIAL_FILE) })],
  ])('rejects %s and never reads the body', (_case, source) => {
    const files = readerOf([source.localPath, BODY]);
    const row = onlyRow([entry(source.entryId)], [source], files.read);
    expect(row).toMatchObject({ status: 'REJECTED', reasonCode: 'SOURCE_IDENTITY_MISMATCH', bodySha256: null });
    expect(files.calls).toEqual([]);
  });

  it('never reads a body that no binding authorizes', () => {
    // Rows and hashes cannot observe an unbound path (nothing iterates the reader), so read-avoidance is the real binding.
    const files = readerOf([OFFICIAL_PATH, BODY], [ORPHAN_PATH, NOT_JSON]);
    inventoryCorpusV2Inputs([entry('entry-official')], [officialSource()], files.read);
    expect(files.calls).toEqual([OFFICIAL_PATH]);
  });

  it('reports MISSING for a body the reader cannot find and for an entry with no binding at all', () => {
    const files = readerOf();
    const inventory = inventoryCorpusV2Inputs(
      [entry('entry-bound'), entry('entry-unbound')],
      [githubSource({ entryId: 'entry-bound', expectedSha256: BODY_SHA256 })],
      files.read,
    );
    expect(inventory.rows).toEqual([
      { entryId: 'entry-bound', identityKind: 'GITHUB', status: 'MISSING', bodySha256: null, byteLength: null, sourceCommit: 'c'.repeat(40), sourcePath: 'workflow.json', reasonCode: 'BODY_NOT_FOUND' },
      { entryId: 'entry-unbound', identityKind: null, status: 'MISSING', bodySha256: null, byteLength: null, sourceCommit: null, sourcePath: null, reasonCode: 'NO_SOURCE_BINDING' },
    ]);
    expect(files.calls).toEqual([GITHUB_PATH]);
  });

  it('classifies an owner-ruled unavailable source without reading anything', () => {
    const files = readerOf([GITHUB_PATH, BODY]); // the bytes exist, but the ruling wins
    const row = onlyRow([entry('entry-github')], [githubSource({ ownerRuledUnavailable: 'RULING-1' })], files.read);
    expect(row).toMatchObject({ identityKind: 'GITHUB', status: 'SOURCE_UNAVAILABLE', reasonCode: 'RULING-1', bodySha256: null, byteLength: null });
    expect(files.calls).toEqual([]);
  });

  it('decodes and parses body bytes: EMPTY_BODY, INVALID_UTF8_BODY, UNPARSEABLE_BODY, or AVAILABLE', () => {
    const pathFor = (entryId: string) => path.join(APPROVED_ROOT, `${entryId}.json`);
    const cases: readonly (readonly [string, Uint8Array, string, string | null])[] = [
      ['entry-brace', encoder.encode('{]'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'], ['entry-closer', encoder.encode('}'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'],
      ['entry-empty', new Uint8Array(0), 'UNPARSEABLE', 'EMPTY_BODY'], ['entry-invalid-utf8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), 'UNPARSEABLE', 'INVALID_UTF8_BODY'],
      ['entry-json', WHITESPACED_JSON, 'AVAILABLE', null], ['entry-notjson', NOT_JSON, 'UNPARSEABLE', 'UNPARSEABLE_BODY'],
      ['entry-scalar', encoder.encode('123'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'], ['entry-trailing', encoder.encode('{}x'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'],
      ['entry-truncated', encoder.encode('{"a":'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'], ['entry-whitespace', encoder.encode('   \n\t'), 'UNPARSEABLE', 'UNPARSEABLE_BODY'],
    ];
    const files = readerOf(...cases.map(([entryId, bytes]) => [pathFor(entryId), bytes] as const));
    const inventory = inventoryCorpusV2Inputs(
      cases.map(([entryId]) => entry(entryId)),
      cases.map(([entryId]) => githubSource({ entryId, localPath: pathFor(entryId) })),
      files.read,
    );
    expect(inventory.rows.map((row) => [row.entryId, row.status, row.reasonCode])).toEqual(
      cases.map(([entryId, , status, reasonCode]) => [entryId, status, reasonCode]),
    );
    expect(Object.fromEntries(inventory.rows.map((row) => [row.entryId, row.bodySha256]))).toMatchObject({
      'entry-empty': EMPTY_SHA256, 'entry-json': WHITESPACED_JSON_SHA256, 'entry-notjson': NOT_JSON_SHA256,
    });
  });

  it('sorts receipts byte-wise by entry id regardless of input order and hashes order-independently', () => {
    const files = readerOf([GITHUB_PATH, BODY]);
    const entries = [entry('entry-c'), entry('entry-a'), entry('entry-b')];
    const sources = [githubSource({ entryId: 'entry-b' }), githubSource({ entryId: 'entry-a' }), githubSource({ entryId: 'entry-c' })];
    const forward = inventoryCorpusV2Inputs(entries, sources, files.read);
    const shuffled = inventoryCorpusV2Inputs([...entries].reverse(), [...sources].reverse(), files.read);
    expect(forward.rows.map((row) => row.entryId)).toEqual(['entry-a', 'entry-b', 'entry-c']);
    expect(shuffled.rows).toEqual(forward.rows);
    expect(shuffled.inventorySha256).toBe(forward.inventorySha256);

    // Raw code units, not locale collation: locale order would be ['a', 'B'].
    const caseOrder = inventoryCorpusV2Inputs([entry('a'), entry('B')], [], files.read);
    expect(caseOrder.rows.map((row) => row.entryId)).toEqual(['B', 'a']);
  });

  it('changes inventorySha256 when a receipt field changes but not when the private paths move', () => {
    const movedRoot = path.join(APPROVED_ROOT, 'elsewhere');
    const movedPath = path.join(movedRoot, 'renamed.json');
    const files = readerOf([GITHUB_PATH, BODY], [movedPath, BODY]);
    const base = inventoryCorpusV2Inputs([entry('entry-github')], [githubSource()], files.read);
    const moved = inventoryCorpusV2Inputs([entry('entry-github')], [githubSource({ localPath: movedPath, approvedRoot: movedRoot })], files.read);
    const changedBytes = inventoryCorpusV2Inputs([entry('entry-github')], [githubSource()], readerOf([GITHUB_PATH, NOT_JSON]).read);
    const changedStatus = inventoryCorpusV2Inputs([entry('entry-github')], [githubSource({ expectedSha256: WRONG_SHA256 })], files.read);
    expect(moved.rows).toEqual(base.rows); // deep equal across different private paths
    expect(moved.inventorySha256).toBe(base.inventorySha256);
    expect(changedBytes.inventorySha256).not.toBe(base.inventorySha256);
    expect(changedStatus.inventorySha256).not.toBe(base.inventorySha256);
  });

  it('reports counts for every status, zeros included', () => {
    const files = readerOf([GITHUB_PATH, BODY], [OFFICIAL_PATH, NOT_JSON]);
    const sources = [
      githubSource({ entryId: 'entry-available' }),
      githubSource({ entryId: 'entry-unavailable', ownerRuledUnavailable: 'RULING-1' }),
      officialSource({ entryId: 'entry-unparseable' }),
      githubSource({ entryId: 'entry-rejected', expectedSha256: WRONG_SHA256 }),
    ];
    const inventory = inventoryCorpusV2Inputs(
      ['entry-available', 'entry-missing', 'entry-unavailable', 'entry-unparseable', 'entry-rejected'].map(entry),
      sources,
      files.read,
    );
    expect(Object.fromEntries(inventory.rows.map((row) => [row.entryId, row.status]))).toEqual({
      'entry-available': 'AVAILABLE',
      'entry-missing': 'MISSING',
      'entry-unavailable': 'SOURCE_UNAVAILABLE',
      'entry-unparseable': 'UNPARSEABLE',
      'entry-rejected': 'REJECTED',
    });
    expect(inventory.counts).toEqual({ AVAILABLE: 1, MISSING: 1, SOURCE_UNAVAILABLE: 1, UNPARSEABLE: 1, REJECTED: 1 });
    expect(Object.keys(inventory.counts)).toEqual(['AVAILABLE', 'MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED']);
    const empty = inventoryCorpusV2Inputs([], [], readerOf().read);
    expect(empty.rows).toEqual([]);
    expect(empty.counts).toEqual({ AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 });
  });
});
