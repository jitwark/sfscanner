import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNeedleMatcher, listArtifactFiles, MIN_SWEEP_LENGTH, resolveMatches, sweepArtifacts } from './published-secret-sweep.mjs';

/** Synthetic needles, never drawn from the corpus: an alphabet that cannot spell a placeholder word. */
const FIRST = 'qqbbjjvvww0123456789';
const SECOND = 'xxzzqqbbjjvv0123456789';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-secret-sweep-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(directory, name, content) {
  const target = path.join(directory, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

const needles = [
  { id: 0, value: FIRST },
  { id: 1, value: SECOND },
];

describe('published secret needle matcher', () => {
  it('finds a needle split across a chunk boundary, because the state carries', () => {
    const matcher = buildNeedleMatcher(needles);
    matcher.feed(Buffer.from(`prefix ${FIRST.slice(0, 5)}`, 'utf8'));
    expect([...matcher.matched()]).toEqual([]);
    matcher.feed(Buffer.from(`${FIRST.slice(5)} suffix`, 'utf8'));
    expect([...matcher.matched()]).toEqual([0]);
  });

  it('reports every needle present and nothing else', () => {
    const matcher = buildNeedleMatcher(needles);
    matcher.feed(Buffer.from(`${FIRST} and ${SECOND}`, 'utf8'));
    expect([...matcher.matched()].sort()).toEqual([0, 1]);
    matcher.reset();
    expect([...matcher.matched()]).toEqual([]);
  });

  it('does not match on a near miss', () => {
    const matcher = buildNeedleMatcher(needles);
    matcher.feed(Buffer.from(`${FIRST.slice(0, -1)}`, 'utf8'));
    expect([...matcher.matched()]).toEqual([]);
  });

  it('tolerates an empty needle set', () => {
    const matcher = buildNeedleMatcher([]);
    matcher.feed(Buffer.from('anything', 'utf8'));
    expect([...matcher.matched()]).toEqual([]);
  });
});

describe('published artifact sweep', () => {
  it('lists every artifact under every root in one deterministic order', () => {
    const directory = temporaryDirectory();
    write(directory, 'b/second.json', '{}');
    write(directory, 'a/first.json', '{}');
    const roots = [path.join(directory, 'b'), path.join(directory, 'a'), path.join(directory, 'missing')];
    const files = listArtifactFiles(roots);
    expect(files).toEqual([...files].sort());
    expect(files.map((file) => path.basename(file))).toEqual(['first.json', 'second.json']);
  });

  it('returns only the artifacts that contain a needle', async () => {
    const directory = temporaryDirectory();
    const hit = write(directory, 'catalogue-0.json', JSON.stringify({ summary: `a ${FIRST} b` }));
    write(directory, 'catalogue-1.json', JSON.stringify({ summary: 'nothing here' }));
    const matches = await sweepArtifacts({ files: listArtifactFiles([directory]), needles });
    expect(matches).toEqual([{ file: hit, needleIds: [0] }]);
  });

  it('is deterministic across runs', async () => {
    const directory = temporaryDirectory();
    write(directory, 'one.json', `{"a":"${FIRST}"}`);
    write(directory, 'two.json', `{"a":"${SECOND}"}`);
    const files = listArtifactFiles([directory]);
    const first = await sweepArtifacts({ files, needles });
    const second = await sweepArtifacts({ files, needles });
    expect(first).toEqual(second);
  });

  it('states the sweep floor rather than leaving it implicit', () => {
    expect(MIN_SWEEP_LENGTH).toBe(8);
  });
});

describe('published secret match location', () => {
  it('resolves the real JSON path of a nested match', () => {
    const directory = temporaryDirectory();
    const file = write(directory, 'shard.json', JSON.stringify({ entries: [{ summary: `x ${FIRST} y` }] }));
    expect(resolveMatches({ file, needleIds: [0], needles })).toEqual([
      { fieldPath: '$.entries[0].summary', needleId: 0 },
    ]);
  });

  it('resolves an ndjson match to its line and path', () => {
    const directory = temporaryDirectory();
    const file = write(directory, 'detail-0.jsonl', `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ body: { value: SECOND } })}\n`);
    expect(resolveMatches({ file, needleIds: [1], needles })).toEqual([
      { fieldPath: 'line[1].body.value', needleId: 1 },
    ]);
  });

  it('reports a line number for an artifact with no structure to walk', () => {
    const directory = temporaryDirectory();
    const file = write(directory, 'page.html', `<html>\n<body>\n<p>${FIRST}</p>\n</body>\n</html>\n`);
    expect(resolveMatches({ file, needleIds: [0], needles })).toEqual([
      { fieldPath: 'line 3', needleId: 0 },
    ]);
  });

  it('reports a binary artifact as binary rather than inventing a line', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'release.sqlite');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x53, 0x51, 0x4c, 0x00]), Buffer.from(SECOND, 'utf8')]));
    expect(resolveMatches({ file, needleIds: [1], needles })).toEqual([
      { fieldPath: 'binary', needleId: 1 },
    ]);
  });

  it('returns nothing for a needle that is not in the artifact', () => {
    const directory = temporaryDirectory();
    const file = write(directory, 'shard.json', '{"entries":[]}');
    expect(resolveMatches({ file, needleIds: [0], needles })).toEqual([]);
  });
});
