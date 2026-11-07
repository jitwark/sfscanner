import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditPrivacyFiles } from './audit-privacy.js';

describe('audit-privacy', () => {
  const testDir = join(process.cwd(), 'pipeline', '.work', 'test-privacy-' + Date.now());

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('catches Class 1: secret canary strings', async () => {
    const filePath = join(testDir, 'canary-fixture.json');
    await writeFile(filePath, JSON.stringify({ note: 'This has canaryFakeSecretKey inside' }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.rule === 'canary')).toBe(true);
  });

  it('catches Class 2: Authorization header with literal credentials', async () => {
    const filePath = join(testDir, 'auth-fixture.json');
    await writeFile(filePath, JSON.stringify({ header: 'Authorization: Bearer mySecretToken123' }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.rule === 'authorization_literal')).toBe(true);
  });

  it('catches Class 3: secret pattern matches (sk-, ghp_, AIza, xox)', async () => {
    const filePath = join(testDir, 'secret-fixture.json');
    await writeFile(filePath, JSON.stringify({ apiKey: 'sk-abcdef12345678901234567890' }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.rule === 'secret_pattern')).toBe(true);
  });

  it('catches Class 4: raw official workflow signature', async () => {
    const filePath = join(testDir, 'official-raw-fixture.json');
    const rawOfficialEntry = {
      source: { kind: 'n8n_official', templateId: 100 },
      nodes: [{ name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } }],
    };
    await writeFile(filePath, JSON.stringify([rawOfficialEntry]));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.rule === 'official_raw_signature')).toBe(true);
  });

  it('passes on clean sanitized data', async () => {
    const filePath = join(testDir, 'clean-fixture.json');
    const cleanEntry = {
      id: 'entry-123',
      title: 'Clean Workflow',
      source: { kind: 'github', repo: 'user/repo' },
      rights: { status: 'redistributable', licence: 'MIT' },
      security: { grade: 'LOW', score: 10 },
    };
    await writeFile(filePath, JSON.stringify([cleanEntry]));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(0);
  });

  it('allows readiness credential labels while still rejecting raw credential objects', async () => {
    const filePath = join(testDir, 'readiness-labels-fixture.json');
    await writeFile(filePath, JSON.stringify({
      entry: { readiness: { credentials: ['Google Sheets', 'Slack'] } },
    }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(0);
  });

  it('does not flag ordinary catalogue labels or documented placeholders as secrets', async () => {
    const filePath = join(testDir, 'derived-labels-fixture.json');
    await writeFile(filePath, JSON.stringify([{
      entry: {
        slug: 'creating-an-onfleet-task-with-a-long-descriptive-name',
        title: 'Set Bearer YOUR_TOKEN_HERE for the task workflow',
        description: 'Use the documented Authorization: Bearer YOUR_TOKEN_HERE placeholder.',
        source: {
          path: 'templates/ai-tools/voice-to-task/workflow.json',
          permalink: 'https://github.com/example/repo/blob/abc/templates/task-workflow.json',
        },
      },
      chart: { nodes: [{ id: 'task-node', name: 'Bearer YOUR_TOKEN_HERE', type: 'http' }] },
    }]));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(0);
  });

  it('still catches a real authorization token in structured catalogue data', async () => {
    const filePath = join(testDir, 'structured-secret-fixture.json');
    await writeFile(filePath, JSON.stringify({
      entry: { description: 'Authorization: Bearer mySecretToken12345' },
    }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.rule === 'authorization_literal')).toBe(true);
  });

  it('catches nested metadata, executable code, and credential objects', async () => {
    const filePath = join(testDir, 'nested-privacy-fixture.json');
    await writeFile(filePath, JSON.stringify({
      nodes: [{
        credentials: { apiKey: 'secret' },
        parameters: { jsCode: 'return [{ json: { ok: true } }];' },
      }],
      meta: { instanceId: 'private-instance' },
    }));

    const res = await auditPrivacyFiles([filePath]);
    expect(res.ok).toBe(false);
    expect(res.hits.filter((hit) => hit.rule === 'forbidden_field').length).toBeGreaterThanOrEqual(3);
  });
});
