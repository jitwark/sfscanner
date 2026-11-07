import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './check-search-governance.mjs';
import { querySetSha256 } from './lib/search-governance.mjs';

const release = {
  releaseId: 'synthetic@2026-08-31T00:00:00.000Z',
  corpusId: 'synthetic',
  generatedAt: '2026-08-31T00:00:00.000Z',
  corpusSha256: 'b'.repeat(64),
};
const tempDirectories = [];

function makeCase(id, split, query = id) {
  return { id, split, sort: 'relevance', query, filters: {} };
}

function makeFixture(cases = [
  makeCase('development-query', 'development'),
  makeCase('holdout-query', 'holdout'),
]) {
  return {
    schemaVersion: 'relevance-set-v2',
    release,
    protocol: {
      tuningSplit: 'development',
      holdoutSplit: 'holdout',
      holdoutPolicy: 'untouched-evaluate-once',
      queryKey: 'query+filters+sort-v1',
      developmentQuerySetSha256: querySetSha256(cases, 'development'),
      holdoutQuerySetSha256: querySetSha256(cases, 'holdout'),
    },
    cases,
  };
}

function fixturePath(fixture, name = 'fixture.json') {
  const directory = mkdtempSync(join(tmpdir(), 'search-governance-'));
  tempDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(fixture), 'utf8');
  return path;
}

function run(args) {
  let stdout = '';
  let stderr = '';
  const exitCode = main(args, {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { exitCode, report: JSON.parse(stdout), stderr };
}

afterEach(() => {
  while (tempDirectories.length) rmSync(tempDirectories.pop(), { recursive: true, force: true });
});

describe('check-search-governance CLI', () => {
  it('prints a compact JSON report and exits zero for a valid temporary fixture', () => {
    const result = run(['--fixture', fixturePath(makeFixture())]);

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ ok: true, releaseId: release.releaseId });
    expect(result.stderr).toBe('');
  });

  it('exits nonzero and reports contamination for an invalid temporary fixture', () => {
    const result = run(['--fixture', fixturePath(makeFixture([
      makeCase('development-query', 'development', 'shared query'),
      makeCase('holdout-query', 'holdout', 'shared query'),
    ]))]);

    expect(result.exitCode).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('canonical query key contamination'),
    ]));
  });

  it('emits byte-identical reports for equivalent fixture ordering', () => {
    const fixture = makeFixture();
    const first = run(['--fixture', fixturePath(fixture, 'first.json')]);
    const second = run(['--fixture', fixturePath(makeFixture([...fixture.cases].reverse()), 'second.json')]);

    expect(JSON.stringify(first.report)).toBe(JSON.stringify(second.report));
  });

  it('fails closed when the release identity option has no value', () => {
    const result = run(['--release-id']);

    expect(result.exitCode).toBe(1);
    expect(result.report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('release-id value is required'),
    ]));
  });
});
