import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditPublicRepoFiles } from './public-repo-content-safety.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-repo-safety-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

describe('public repository content safety audit', () => {
  it('accepts clean source and documented placeholders', () => {
    const root = fixture();
    const file = write(root, 'README.md', [
      '# Example',
      'Use YOUR_TOKEN_HERE, <redacted:api-key>, ${ENV_TOKEN}, or REPLACE_ME.',
      'No credential is included in this documentation.',
    ].join('\n'));

    expect(auditPublicRepoFiles([file])).toEqual({ ok: true, findings: [] });
  });

  it('allows public security prose that describes confidential data as an asset', () => {
    const root = fixture();
    const file = write(root, 'threat-model.md', 'Personal and confidential data can be present in a workflow.\n');

    expect(auditPublicRepoFiles([file])).toEqual({ ok: true, findings: [] });
  });

  it('detects known secret patterns and Authorization literals without exposing values', () => {
    const root = fixture();
    const secret = 'sk-proj-12345678901234567890';
    const file = write(root, 'src/config.js', [
      `const apiKey = '${secret}';`,
      'fetch(url, { headers: { Authorization: "Bearer live-secret-value" } });',
    ].join('\n'));

    const result = auditPublicRepoFiles([file]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual([
      'authorization-literal',
      'secret-pattern:openai-api-key',
    ]);
    expect(JSON.stringify(result.findings)).not.toContain(secret);
    expect(result.findings.every(({ snippet }) => snippet.length <= 120)).toBe(true);
  });

  it('does not treat a hyphenated word ending in sk as an OpenAI key prefix', () => {
    const root = fixture();
    const file = write(root, 'src/routes.txt', 'https://example.test/manual-zendesk-automation-scheduled/\n');

    expect(auditPublicRepoFiles([file])).toEqual({ ok: true, findings: [] });
  });

  it('detects canary strings and credential or private-key filenames', () => {
    const root = fixture();
    const canary = write(root, 'fixtures/workflow.json', '{"value":"canaryFakeSecretKey"}');
    const privateKey = write(root, 'credentials/private-key.pem', 'not a real key');

    const result = auditPublicRepoFiles([privateKey, canary]);
    expect(result.findings.map(({ rule }) => rule)).toEqual([
      'canary-string',
      'credential-filename',
    ]);
    expect(JSON.stringify(result.findings)).not.toContain('canaryFakeSecretKey');
  });

  it('detects high-entropy token-like text', () => {
    const root = fixture();
    const token = 'vK8xQ2mN7pL4sR9tW3yF6hJ1cD5gB0zX8qA4eS7uI2oP6nM9';
    const file = write(root, 'src/generated.txt', `integrity: sha512-${token}\nvalue=${token}\n`);

    const result = auditPublicRepoFiles([file]);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['high-entropy-token']);
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it('does not let unrelated integrity wording suppress a sensitive high-entropy value', () => {
    const root = fixture();
    const token = 'vK8xQ2mN7pL4sR9tW3yF6hJ1cD5gB0zX8qA4eS7uI2oP6nM9';
    const file = write(root, 'src/config.js', `const headers = { value: '${token}' }; // integrity metadata is documented separately\n`);

    const result = auditPublicRepoFiles([file]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['high-entropy-token']);
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it('ignores long package metadata URLs outside sensitive assignments', () => {
    const root = fixture();
    const file = write(root, 'package-lock.json', '"resolved": "https://registry.npmjs.org/package/-/package-1.2.3.tgz"\n');

    expect(auditPublicRepoFiles([file])).toEqual({ ok: true, findings: [] });
  });

  it('sorts findings deterministically regardless of explicit path order', () => {
    const root = fixture();
    const first = write(root, 'z-last.js', 'const token = sk-proj-12345678901234567890;');
    const second = write(root, 'a-first.js', 'Authorization: Bearer secret-value;');

    const forward = auditPublicRepoFiles([first, second]);
    const reverse = auditPublicRepoFiles([second, first]);
    expect(forward).toEqual(reverse);
    expect(forward.findings.map(({ path: findingPath }) => findingPath)).toEqual([
      second.replaceAll('\\', '/'), first.replaceAll('\\', '/'),
    ]);
  });

  it('fails closed for missing paths and paths that are not regular files', () => {
    const root = fixture();
    const directory = path.join(root, 'directory');
    fs.mkdirSync(directory);
    const missing = path.join(root, 'missing.txt');

    const result = auditPublicRepoFiles([missing, directory]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual([
      'unreadable-file',
      'unreadable-file',
    ]);
    expect(result.findings.every(({ snippet }) => snippet === null)).toBe(true);
  });

  it('rejects mixed-case dotenv filenames before content is inspected', () => {
    const root = fixture();
    const file = write(root, 'config/.EnV.Local', 'PUBLIC_DOCUMENTED_VALUE=true\n');

    const result = auditPublicRepoFiles([file]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['credential-filename']);
  });

  it('rejects internal, pre-decisional, and process-document markers without echoing document text', () => {
    const root = fixture();
    const file = write(root, 'review.md', [
      '# Internal audit report',
      '> PRE-DECISIONAL — do not publish',
      'Owner: OWNER_TO_BE_CONFIRMED',
      '- [ ] release decision remains open',
    ].join('\n'));

    const result = auditPublicRepoFiles([file]);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['internal-document-marker']);
    expect(result.findings[0]).toMatchObject({ line: 1, column: 1, snippet: null });
    expect(JSON.stringify(result.findings)).not.toContain('OWNER_TO_BE_CONFIRMED');
  });

  it('rejects known private process-document paths even when their content is otherwise clean', () => {
    const root = fixture();
    const file = write(root, 'docs/audit/clean.md', '# Findings\n');

    const result = auditPublicRepoFiles([file]);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['internal-document-marker']);
    expect(result.findings[0]).toMatchObject({ line: 0, column: 0, snippet: null });
  });

  it('reads a backticked marker as a quoted mention, never as this document\'s own status', () => {
    const root = fixture();
    const mention = write(root, 'public.md', 'They record the open target as `OWNER_TO_BE_CONFIRMED` in another document.\n');
    const status = write(root, 'status.md', 'Owner: OWNER_TO_BE_CONFIRMED\n');

    expect(auditPublicRepoFiles([mention])).toEqual({ ok: true, findings: [] });

    const result = auditPublicRepoFiles([status]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ rule }) => rule)).toEqual(['internal-document-marker']);
    expect(result.findings[0]).toMatchObject({ line: 1, column: 8, snippet: null });
  });
});
