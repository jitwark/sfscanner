import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectInputs } from './input-selection';
import { writeAtomicUtf8V2 } from './atomic-output';
import { readInputBytes } from './input-read';
import { admittedLabelV2, isAbsoluteAdmittedPathV2, isAdmittedLocalPath, isAdmittedRelativePath, isWithinBaseV2, toFsPathV2 } from './path-admission';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const canCreateFileSymlinks = process.platform !== 'win32' || process.env.SFSCANNER_TEST_SYMLINKS === '1';
const OUTSIDE_WORKFLOW = '{"nodes":[{"id":"outside","name":"Outside","type":"n8n-nodes-base.noOp","typeVersion":1,"parameters":{}}],"connections":{}}';
const BASE_WORKFLOW = '{"nodes":[],"connections":{}}';

describe('v2 path admission', () => {
  it('admits absolute paths and rejects remote, UNC, and traversal near-misses', () => {
    expect(isAdmittedLocalPath('/work/a.json')).toBe(true);
    expect(isAdmittedLocalPath('C:\\work\\a.json')).toBe(true);
    expect(isAdmittedLocalPath('C:/work/../secret.json')).toBe(false);
    expect(isAdmittedLocalPath('https://example.test/a.json')).toBe(false);
    expect(isAdmittedLocalPath('//server/share/a.json')).toBe(false);
    expect(isAdmittedLocalPath('a/../../b.json')).toBe(false);
    expect(isAdmittedRelativePath('C:\\work\\a.json')).toBe(false);
    expect(isAdmittedRelativePath('.')).toBe(false);
    expect(isAdmittedRelativePath('sub/a.json')).toBe(true);
  });

  it('never treats a cross-drive relative result as containment', () => {
    expect(isWithinBaseV2('D:/work/a.json', 'C:/work')).toBe(false);
    expect(admittedLabelV2('D:/work/a.json', 'C:/work')).toBe('a.json');
    expect(admittedLabelV2('C:/work/a.json', 'C:/work')).toBe('a.json');
    expect(isWithinBaseV2('C:/work/a.json', 'C:/work')).toBe(true);
  });

  it('normalizes backslashes inside the absolute predicate', () => {
    expect(isAbsoluteAdmittedPathV2('C:\\work\\a.json')).toBe(true);
    expect(isAbsoluteAdmittedPathV2('\\\\server\\share\\a.json')).toBe(false);
  });

  it('preserves the POSIX and drive roots when joining', () => {
    expect(toFsPathV2('/', 'a.json')).toBe('/a.json');
    expect(toFsPathV2('C:/', 'a.json')).toBe('C:/a.json');
    expect(toFsPathV2('C:/work/', 'a.json')).toBe('C:/work/a.json');
  });

  it('admits an absolute file and emits a relative label', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-abs-'));
    roots.push(dir);
    const file = path.join(dir, 'clean.json');
    await writeFile(file, '{"nodes":[],"connections":{}}');
    const result = await collectInputs({ inputs: [file], baseDirectory: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs[0]!.label).toBe('clean.json');
    expect(result.inputs[0]!.realPath).toBe((await realpath(file)).replaceAll('\\', '/'));
  });

  it('deduplicates by resolved file identity, not by input spelling', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-dedup-'));
    roots.push(dir);
    const file = path.join(dir, 'clean.json');
    await writeFile(file, '{"nodes":[],"connections":{}}');
    const result = await collectInputs({
      inputs: ['clean.json', file.replaceAll('\\', '/')],
      baseDirectory: dir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]!.label).toBe('clean.json');
  });

  it('labels an absolute input outside the base by basename', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sf-base-'));
    const other = await mkdtemp(path.join(os.tmpdir(), 'sf-other-'));
    roots.push(base, other);
    const file = path.join(other, 'outside.json');
    await writeFile(file, '{"nodes":[],"connections":{}}');
    const result = await collectInputs({ inputs: [file], baseDirectory: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs[0]!.label).toBe('outside.json');
    const read = await readInputBytes(result.inputs[0]!, { baseDirectory: base });
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe('{"nodes":[],"connections":{}}');
  });

  it('reads an inside-base absolute directory by its real path', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sf-inside-'));
    roots.push(base);
    await mkdir(path.join(base, 'sub'));
    await writeFile(path.join(base, 'sub', 'flow.json'), BASE_WORKFLOW);
    const selected = await collectInputs({ inputs: [path.join(base, 'sub')], baseDirectory: base });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.inputs.map(({ label }) => label)).toEqual(['sub/flow.json']);
    const read = await readInputBytes(selected.inputs[0]!, { baseDirectory: base });
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe(BASE_WORKFLOW);
  });

  it('admits the selection root with a dot input', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-dot-'));
    roots.push(dir);
    await writeFile(path.join(dir, 'clean.json'), '{"nodes":[],"connections":{}}');
    const result = await collectInputs({ inputs: ['.'], baseDirectory: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs.map((item) => item.label)).toEqual(['clean.json']);
  });

  it('labels the absolute base itself without a basename prefix', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sf-self-'));
    roots.push(base);
    await writeFile(path.join(base, 'clean.json'), BASE_WORKFLOW);
    expect(admittedLabelV2(base, base)).toBe('');
    const result = await collectInputs({ inputs: [base], baseDirectory: base });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputs.map(({ label }) => label)).toEqual(['clean.json']);
  });

  it('reads an outside absolute directory by its selected real path', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sf-h2-base-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'sf-h2-out-'));
    roots.push(base, outside);
    const outsideName = path.basename(outside);
    await mkdir(path.join(base, outsideName, 'other'), { recursive: true });
    await mkdir(path.join(outside, 'other'));
    await writeFile(path.join(base, outsideName, 'other', 'flow.json'), BASE_WORKFLOW);
    await writeFile(path.join(outside, 'other', 'flow.json'), OUTSIDE_WORKFLOW);
    const selected = await collectInputs({ inputs: [outside], baseDirectory: base });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const item = selected.inputs.find(({ label }) => label === `${outsideName}/other/flow.json`)!;
    expect(item.realPath).toBe((await realpath(path.join(outside, 'other', 'flow.json'))).replaceAll('\\', '/'));
    const read = await readInputBytes(item, { baseDirectory: base });
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe(OUTSIDE_WORKFLOW);
    expect(await readFile(path.join(base, outsideName, 'other', 'flow.json'), 'utf8')).toBe(BASE_WORKFLOW);
  });

  it('deduplicates a link-aliased file path and its target by resolved identity', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sf-dedup-link-'));
    roots.push(base);
    await mkdir(path.join(base, 'real'));
    await writeFile(path.join(base, 'real', 'clean.json'), BASE_WORKFLOW);
    await symlink(path.join(base, 'real'), path.join(base, 'alias'), linkType);
    const result = await collectInputs({ inputs: ['real/clean.json', 'alias/clean.json'], baseDirectory: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]!.realPath).toBe((await realpath(path.join(base, 'real', 'clean.json'))).replaceAll('\\', '/'));
  });

  it('accepts a symlinked ancestor directory but rejects a symlinked target', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-link-'));
    roots.push(dir);
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    await mkdir(real);
    await symlink(real, link, linkType);
    expect((await writeAtomicUtf8V2('link/out.json', '{}\n', { baseDirectory: dir })).ok).toBe(true);
    if (!canCreateFileSymlinks) {
      // Windows file symlinks need Developer Mode or elevation; the directory-ancestor
      // branch above still runs on every platform, and the production rejection is
      // covered by atomic-output.test.ts's target-link case.
      return;
    }
    await symlink(path.join(real, 'target.json'), path.join(dir, 'target.json'), 'file');
    expect((await writeAtomicUtf8V2('target.json', '{}\n', { baseDirectory: dir })).ok).toBe(false);
  });
});
