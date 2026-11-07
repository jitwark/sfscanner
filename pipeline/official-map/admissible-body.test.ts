import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHENTIC_BODY_KEYS,
  classifyOfficialBody,
  NOT_A_WORKFLOW_BODY,
  readOfficialBody,
  readOfficialBodyVerdict,
  stripAnnotations,
} from './admissible-body';

const scratch: string[] = [];

function writeBody(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'admissible-body-'));
  scratch.push(dir);
  const file = path.join(dir, 'official__1_fixture.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shape a curated body actually has: `id/name/nodes/connections` plus export metadata. */
const curatedShape = {
  id: 42,
  name: 'Fixture',
  nodes: [],
  connections: {},
  settings: {},
  pinData: {},
  meta: { instanceId: 'abc' },
  active: false,
  tags: [],
  versionId: 'v1',
};

/** What the legacy master adds on top of it. */
const annotatedShape = { ...curatedShape, _security: { verdict: 'safe' }, _documentation: 'model prose' };

describe('the authentic key allowlist', () => {
  it('is exactly the key union measured across the curated corpus plus the three owner-admitted fields', () => {
    // Every key the 9,564 curated bodies carry, and nothing else except the three
    // fields the owner admitted after measuring them across both bound folders
    // (docs/audit/2026-09-28-body-coverage/refused-bodies-evidence.md). Changing
    // this set changes which bodies the map may use, so it is pinned here rather
    // than left to whatever the classifier happens to accept.
    expect(Object.keys(AUTHENTIC_BODY_KEYS).sort()).toEqual([
      '_fileName',
      '_meta',
      'active',
      'activeVersion',
      'activeVersionId',
      'canExecute',
      'connections',
      'createdAt',
      'description',
      'id',
      'isArchived',
      'meta',
      'name',
      'nodeGroups',
      'nodes',
      'notes',
      'parentFolderId',
      'pinData',
      'scopes',
      'settings',
      'shared',
      'staticData',
      'tags',
      'triggerCount',
      'updatedAt',
      'version',
      'versionCounter',
      'versionId',
      'versionMetadata',
    ]);
    // The two injected blocks are the whole point of the guard.
    expect(Object.hasOwn(AUTHENTIC_BODY_KEYS, '_security')).toBe(false);
    expect(Object.hasOwn(AUTHENTIC_BODY_KEYS, '_documentation')).toBe(false);
  });
});

describe('official body classification', () => {
  it('accepts a body whose keys are a subset of the allowlist', () => {
    expect(classifyOfficialBody(curatedShape)).toEqual({ kind: 'authentic' });
    expect(classifyOfficialBody({ id: 1, name: 'n', nodes: [], connections: {}, settings: {} })).toEqual({
      kind: 'authentic',
    });
  });

  it('refuses an annotated body and names the offending keys', () => {
    expect(classifyOfficialBody(annotatedShape)).toEqual({
      kind: 'annotated',
      offendingKeys: ['_documentation', '_security'],
    });
    expect(classifyOfficialBody({ ...curatedShape, _documentation: 'x' })).toEqual({
      kind: 'annotated',
      offendingKeys: ['_documentation'],
    });
  });

  it('reports a file that is not a workflow object rather than treating it as absent', () => {
    expect(classifyOfficialBody([1, 2])).toEqual({ kind: 'annotated', offendingKeys: [NOT_A_WORKFLOW_BODY] });
    expect(classifyOfficialBody(null)).toEqual({ kind: 'annotated', offendingKeys: [NOT_A_WORKFLOW_BODY] });
    expect(classifyOfficialBody('a body')).toEqual({ kind: 'annotated', offendingKeys: [NOT_A_WORKFLOW_BODY] });
  });

  it('reads a body off disk, and refuses unparseable JSON instead of counting it as a body', () => {
    expect(readOfficialBodyVerdict(writeBody(JSON.stringify(curatedShape)))).toEqual({ kind: 'authentic' });
    expect(readOfficialBodyVerdict(writeBody(JSON.stringify(annotatedShape)))).toEqual({
      kind: 'annotated',
      offendingKeys: ['_documentation', '_security'],
    });
    expect(readOfficialBodyVerdict(writeBody('{ not json'))).toEqual({
      kind: 'annotated',
      offendingKeys: [NOT_A_WORKFLOW_BODY],
    });
    expect(readOfficialBodyVerdict(path.join(os.tmpdir(), 'admissible-body-absent', 'nope.json'))).toEqual({
      kind: 'annotated',
      offendingKeys: [NOT_A_WORKFLOW_BODY],
    });
  });

  it('accepts the owner-admitted backfill fields as authentic', () => {
    expect(classifyOfficialBody({ ...curatedShape, canExecute: true, parentFolderId: null })).toEqual({
      kind: 'authentic',
    });
    expect(classifyOfficialBody({ ...curatedShape, _fileName: 'Bulk.json' })).toEqual({ kind: 'authentic' });
  });

  it('still refuses the injected blocks the guard exists for', () => {
    expect(classifyOfficialBody({ ...curatedShape, _security: {} })).toEqual({
      kind: 'annotated',
      offendingKeys: ['_security'],
    });
    expect(
      classifyOfficialBody({ ...curatedShape, canExecute: true, _documentation: 'x' }),
    ).toEqual({ kind: 'annotated', offendingKeys: ['_documentation'] });
  });

  it('reads the parsed body too, so a caller never has to read the file twice', () => {
    expect(readOfficialBody(writeBody(JSON.stringify(curatedShape)))).toEqual(curatedShape);
    expect(readOfficialBody(writeBody('{ not json'))).toBeUndefined();
  });
});

describe('stripping annotations', () => {
  it('removes every key outside the allowlist and names each one it removed', () => {
    const { body, removedKeys } = stripAnnotations(annotatedShape);

    expect(removedKeys).toEqual(['_documentation', '_security']);
    expect(classifyOfficialBody(body)).toEqual({ kind: 'authentic' });
    expect(Object.keys(body)).toEqual(Object.keys(curatedShape));
    // The input is not edited: a caller that still holds the annotated body still sees it.
    expect(Object.keys(annotatedShape)).toContain('_security');
  });

  it('removes nothing from an authentic body and says so', () => {
    expect(stripAnnotations(curatedShape)).toEqual({ body: curatedShape, removedKeys: [] });
  });

  it('refuses to strip something that is not a workflow body', () => {
    expect(() => stripAnnotations([1, 2])).toThrow(NOT_A_WORKFLOW_BODY);
    expect(() => stripAnnotations(null)).toThrow(NOT_A_WORKFLOW_BODY);
  });
});
