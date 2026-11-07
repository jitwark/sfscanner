import { describe, expect, it } from 'vitest';
import {
  buildIssueClassificationReport,
  renderIssueClassificationMarkdown,
  renderIssueClassificationSummary,
  REPORT_SCHEMA_VERSION,
} from './public-repo-issue-report.mjs';

function fixtureManifest() {
  return {
    targetRepository: 'n8n-Secureflow',
    files: [],
    issues: [
      { code: 'denied-path', path: '.env.local', message: 'environment file' },
      { code: 'unexpected-path', path: 'skills-lock.json', message: 'file is outside the explicit allowlist' },
      { code: 'unsafe-content', path: 'README.md', message: 'secret-pattern:openai-api-key at 3:5' },
      { code: 'unsafe-content', path: 'app/foo.ts', message: 'canary-string at 9:1' },
    ],
  };
}

describe('public repository issue classification report', () => {
  it('declares a schema version', () => {
    expect(typeof REPORT_SCHEMA_VERSION).toBe('string');
    expect(REPORT_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it('groups issues by class and, for unsafe-content, by underlying rule', () => {
    const report = buildIssueClassificationReport({
      manifest: fixtureManifest(),
      requiredMissing: [{ path: 'examples', description: 'Phase 7 standalone tree requires an examples/ directory.' }],
      structuralGaps: [{ requiredPath: 'packages/scanner-cli', existingPath: 'pipeline/cli', description: 'Phase 7 requires packages/scanner-cli; only pipeline/cli exists. Migrating is a packaging task, not a rename.' }],
      exemptionSummary: { appliedCount: 2, stale: [] },
    });

    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.totals.byCode).toMatchObject({ 'denied-path': 1, 'unexpected-path': 1, 'unsafe-content': 2 });
    expect(report.totals.unsafeContentByRule).toMatchObject({ 'secret-pattern:openai-api-key': 1, 'canary-string': 1 });
    expect(report.requiredMissing).toHaveLength(1);
    expect(report.structuralGaps).toHaveLength(1);
    expect(report.exemptionSummary.appliedCount).toBe(2);
    expect(report.items['unsafe-content']).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md' }),
    ]));
  });

  it('renders markdown with headers for every class, counts, and the required/structural sections', () => {
    const report = buildIssueClassificationReport({
      manifest: fixtureManifest(),
      requiredMissing: [{ path: 'examples', description: 'Phase 7 standalone tree requires an examples/ directory.' }],
      structuralGaps: [{ requiredPath: 'packages/scanner-cli', existingPath: 'pipeline/cli', description: 'migration needed' }],
      exemptionSummary: { appliedCount: 0, stale: [] },
    });

    const markdown = renderIssueClassificationMarkdown(report);

    expect(markdown).toContain('denied-path');
    expect(markdown).toContain('unexpected-path');
    expect(markdown).toContain('unsafe-content');
    expect(markdown).toContain('secret-pattern:openai-api-key');
    expect(markdown).toContain('examples');
    expect(markdown).toContain('packages/scanner-cli');
    expect(markdown).toContain('pipeline/cli');
  });

  it('renders a short stdout summary with per-class and per-rule counts', () => {
    const report = buildIssueClassificationReport({
      manifest: fixtureManifest(),
      requiredMissing: [],
      structuralGaps: [],
      exemptionSummary: { appliedCount: 0, stale: [] },
    });

    const summary = renderIssueClassificationSummary(report);

    expect(summary).toContain('denied-path: 1');
    expect(summary).toContain('unexpected-path: 1');
    expect(summary).toContain('unsafe-content: 2');
    expect(summary).toContain('secret-pattern:openai-api-key: 1');
  });
});
