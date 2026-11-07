import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { projectionDigest, readSourceFacts, sampleSpecs } from './check-export-spot-check.mjs';

const script = path.resolve(import.meta.dirname, 'check-export-spot-check.mjs');
const temporary = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const SITE_URL = 'https://example.test';

function page(canonical) {
  return '<!doctype html><html data-theme="dark"><head><title>n8n-secureflow</title>'
    + `<meta name="description" content="${'Filler description sentence. '.repeat(20)}"/>`
    + `<link rel="canonical" href="${canonical}"/>`
    + '</head><body><header>n8n-secureflow</header>'
    + '<footer>© 2026 n8n-secureflow community</footer></body></html>';
}

function fixture({ entryCanonical = `${SITE_URL}/w/example/` } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spot-check-'));
  temporary.push(root);
  const source = path.join(root, 'source');
  const out = path.join(root, 'out');
  const write = (relative, content) => {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  // Only the file the gate actually reads: the site name is the source literal,
  // and the origin comes from the environment, not from a source constant.
  write('app/src/seo/page-meta.ts', "export const SITE_NAME = 'n8n-secureflow';\n");
  const emit = (relative, content) => {
    const file = path.join(out, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  emit('index.html', page(`${SITE_URL}/`));
  emit('about/index.html', page(`${SITE_URL}/about/`));
  emit('w/example/index.html', page(entryCanonical));
  return { source, out };
}

function run(out, { source, env = {} } = {}) {
  return spawnSync(process.execPath, [script, out], {
    env: { ...process.env, SOURCE_ROOT: source, NEXT_PUBLIC_SITE_URL: SITE_URL, ...env },
    encoding: 'utf8',
  });
}

describe('export spot-check', () => {
  it('passes when every sampled page agrees with its source facts', () => {
    const { out, source } = fixture();
    const result = run(out, { source });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Export spot-check passed: 3 sampled pages');
    expect(result.stdout).toContain('facts=2');
  });

  it('fails and names the fact when the export disagrees with the source', () => {
    const { out, source } = fixture();
    const entry = path.join(out, 'w/example/index.html');
    fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(`${SITE_URL}/w/example/`, 'https://stale.example/w/example/'));
    const result = run(out, { source });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('canonical');
    expect(`${result.stdout}${result.stderr}`).toContain('stale.example');
  });

  it('fails when a source literal is absent from the export', () => {
    const { out, source } = fixture();
    const about = path.join(out, 'about/index.html');
    fs.writeFileSync(about, fs.readFileSync(about, 'utf8').replaceAll('n8n-secureflow', 'another-site'));
    const result = run(out, { source });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('siteName');
    expect(`${result.stdout}${result.stderr}`).toContain('<missing>');
  });

  it('fails closed when no workflow entry page can be sampled', () => {
    const { out, source } = fixture();
    fs.rmSync(path.join(out, 'w'), { recursive: true });
    const result = run(out, { source });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('no workflow entry page');
  });

  it('fails closed and names the env when no release origin is configured', () => {
    const { out, source } = fixture();
    const result = run(out, { source, env: { NEXT_PUBLIC_SITE_URL: '' } });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('NEXT_PUBLIC_SITE_URL');
  });

  it('drops the canonical fact in a preview export but keeps the literal fact', () => {
    const { out, source } = fixture();
    const result = run(out, { source, env: { NEXT_PUBLIC_BUILD_MODE: 'preview' } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('facts=1');
  });
});

describe('export spot-check source selection', () => {
  it('projects facts in declaration order, so reordering changes the digest', () => {
    const ordered = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }];
    expect(projectionDigest(ordered)).toBe(projectionDigest([...ordered]));
    expect(projectionDigest(ordered)).not.toBe(projectionDigest([...ordered].reverse()));
  });

  it('reads only the site name and the configured origin, never a repository literal', () => {
    const { source } = fixture();
    const facts = readSourceFacts(source, { NEXT_PUBLIC_SITE_URL: SITE_URL });
    expect(facts).toEqual({ siteName: 'n8n-secureflow', siteUrl: SITE_URL });
    expect(facts).not.toHaveProperty('repositoryUrl');
  });

  it('rejects a non-https release origin instead of comparing against it', () => {
    const { source } = fixture();
    expect(() => readSourceFacts(source, { NEXT_PUBLIC_SITE_URL: 'http://example.test' })).toThrow(/https URL/);
    expect(() => readSourceFacts(source, { NEXT_PUBLIC_SITE_URL: 'https://u:p@example.test' })).toThrow(/credentials/);
  });

  it('samples the lexicographically first entry page and adds it to the fixed two', () => {
    const { out } = fixture();
    fs.mkdirSync(path.join(out, 'w/aaa'), { recursive: true });
    fs.writeFileSync(path.join(out, 'w/aaa/index.html'), page(`${SITE_URL}/w/aaa/`));
    expect(sampleSpecs(out).map((spec) => spec.route)).toEqual(['/', '/about/', '/w/aaa/']);
  });
});
