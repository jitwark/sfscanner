import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Active root CI is also reused by the source-only distribution extractor. */
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const activeRootWorkflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const activeRootWorkflow = existsSync(activeRootWorkflowPath) ? readFileSync(activeRootWorkflowPath, 'utf8') : null;

describe('the CI workflow shipped to the standalone repository', () => {
  it('runs the source-only sequence, because the corpus is not published there', () => {
    // `npm run gates` includes build, check:docs, check:links and test:e2e,
    // every one of which reads `data/`. That repository ships source without
    // the corpus on purpose, so running the canonical sequence there could
    // never go green — and for its whole history, it never did.
    expect(workflow).toContain('run: npm run gates:source');
    expect(workflow).not.toMatch(/run: npm run gates\s*$/mu);
    expect(workflow).toContain('node-version: 22.x');
    expect(workflow).toContain('run: npm ci');
    expect(workflow).toContain('GATE_SUMMARY_PATH: pipeline/.work/gate-summary.json');
  });

  it('carries the standalone repository identity, not this one', () => {
    expect(workflow).toMatch(/^name: n8n-secureflow$/mu);
    expect(workflow).not.toContain('community-hub-gate-summary');
  });

  it('pins every action to an immutable commit and limits token permissions', () => {
    // The property, not the versions. Asserting exact tags meant every
    // legitimate bump broke a test that was really about supply-chain
    // pinning — and a test that breaks for the wrong reason gets edited
    // without being read.
    const uses = [...workflow.matchAll(/uses:\s*(\S+)(?:\s*#\s*(\S+))?/gu)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, reference, comment] of uses) {
      expect(reference, `${reference} must be pinned to a 40-character commit SHA`)
        .toMatch(/^[^@]+@[0-9a-f]{40}$/u);
      expect(comment, `${reference} must name the version it pins in a trailing comment`)
        .toMatch(/^v\d/u);
    }
    expect(workflow).not.toMatch(/uses: .*@[vV]\d/u);
    expect(workflow).toMatch(/permissions:\s+contents: read/u);
    expect(workflow).toContain('cancel-in-progress: true');
  });
});

if (activeRootWorkflow !== null) describe('active repository packed CLI matrix', () => {
  it('runs the packed CLI contract on Linux, Windows, and macOS', () => {
    expect(activeRootWorkflow).toContain('packed-cli:');
    expect(activeRootWorkflow).toContain('os: [ubuntu-24.04, windows-2025, macos-14]');
    expect(activeRootWorkflow).not.toContain('working-directory: community-hub');
    expect(activeRootWorkflow).toContain('cache-dependency-path: package-lock.json');
    expect(activeRootWorkflow).toContain('run: node scripts/verify-packed-cli.mjs');
  });
});
