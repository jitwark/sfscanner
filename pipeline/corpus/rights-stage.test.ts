import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, SourceDef } from '@hub/contracts';
import { runRightsStage, type RightsStageOptions } from './rights-stage.js';

/**
 * Task 6.7, requirements 2 and 4.
 *
 * The stage is where the chain's evidence reaches the decision, and where a
 * quarantine becomes real: a quarantined candidate is removed from the list
 * every later stage reads and recorded in the evidence ledger, outside every
 * published output. The one thing it must never do is leave the candidate in
 * place with a publishable status.
 */
const runId = 'test-rights-stage-evidence';
const workDir = path.join(process.cwd(), 'pipeline', '.work', runId);
const ledgerPath = path.join(workDir, 'stages.jsonl');
const evidencePath = path.join(workDir, 'rights-evidence.jsonl');

const source = (key: string, repo: string): SourceDef => ({
  key,
  kind: 'github',
  repo,
  branch: 'main',
  include: [],
  exclude: [],
  expectedLicence: 'MIT',
  status: 'active',
  note: 'test source',
  reviewedAt: '2026-08-13',
});

const candidate = (id: string, repo: string, filePath: string): Candidate => ({
  id,
  source: {
    kind: 'github',
    repo,
    owner: repo.split('/')[0]!,
    path: filePath,
    commit: 'c'.repeat(40),
    permalink: `https://github.com/${repo}/blob/${'c'.repeat(40)}/${filePath}`,
    fetchedAt: '2026-08-13T00:00:00.000Z',
  },
  rights: { status: 'link_only', licence: 'MIT', licenceUrl: 'https://api.github.com/licenses/mit', reason: 'pending' },
  title: 'fixture workflow',
  json: { name: 'fixture', nodes: [], connections: {} },
  bytes: 42,
  blobSha: 'b'.repeat(40),
});

const options = (candidates: Candidate[]): RightsStageOptions => ({
  candidates,
  sources: [source('repo', 'owner/repo')],
  repoEvidence: new Map([
    ['owner/repo', {
      readmeHead: null,
      owner: 'owner',
      licenceFiles: [{ filename: 'LICENSE', sha256: 'root-licence-hash' }],
      licenceBasis: 'same-commit-file' as const,
    }],
  ]),
  ledgerPath,
});

async function readEvidenceLedger(): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(evidencePath, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(async () => {
  await fs.mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('runRightsStage', () => {
  it('publishes a redistributable decision only from same-commit licence evidence', async () => {
    const candidates = [candidate('clean', 'owner/repo', 'workflows/one.json')];

    await runRightsStage(options(candidates));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rights.status).toBe('redistributable');
    // The published record stays the four-field rights contract: the evidence
    // must not ride along into the catalogue.
    expect(Object.keys(candidates[0]!.rights).sort()).toEqual(['licence', 'licenceUrl', 'reason', 'status']);
  });

  it('quarantines a candidate whose subtree licence contradicts the repository licence', async () => {
    const candidates = [
      candidate('conflicted', 'owner/repo', 'collection/one.json'),
      candidate('clean', 'owner/repo', 'workflows/two.json'),
    ];
    const stage = options(candidates);
    stage.repoEvidence.set('owner/repo', {
      readmeHead: null,
      owner: 'owner',
      licenceFiles: [
        { filename: 'LICENSE', sha256: 'root-licence-hash' },
        { filename: 'collection/LICENSE', sha256: 'other-licence-hash' },
      ],
      licenceBasis: 'same-commit-file' as const,
    });

    await runRightsStage(stage);

    // Removed from the array every later stage reads — not published.
    expect(candidates.map((c) => c.id)).toEqual(['clean']);
    expect(candidates[0]!.rights.status).toBe('redistributable');

    const ledger = await readEvidenceLedger();
    expect(ledger).toHaveLength(2);
    expect(ledger.find((line) => line.id === 'conflicted')).toMatchObject({
      status: 'excluded',
      disposition: 'quarantine',
      evidence: {
        workflowPath: 'collection/one.json',
        siblingLicence: [{ filename: 'collection/LICENSE', sha256: 'other-licence-hash' }],
      },
    });
  });

  it('withholds redistribution when the licence identifier was metadata-only', async () => {
    const candidates = [candidate('metadata', 'owner/repo', 'workflows/one.json')];
    const stage = options(candidates);
    stage.repoEvidence.set('owner/repo', {
      readmeHead: null,
      owner: 'owner',
      licenceFiles: [],
      licenceBasis: 'metadata-only' as const,
    });

    await runRightsStage(stage);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rights.status).toBe('link_only');
    expect(candidates[0]!.rights.reason).toContain('metadata');
  });

  it('carries the source commit, workflow path and body hash into the decision evidence', async () => {
    const candidates = [candidate('clean', 'owner/repo', 'workflows/one.json')];

    await runRightsStage(options(candidates));

    const [line] = await readEvidenceLedger();
    expect(line).toMatchObject({
      id: 'clean',
      status: 'redistributable',
      disposition: 'publish',
      evidence: {
        sourceCommit: 'c'.repeat(40),
        bodyHash: 'b'.repeat(40),
        workflowPath: 'workflows/one.json',
        rootLicence: [{ filename: 'LICENSE', sha256: 'root-licence-hash' }],
        licenceBasis: 'same-commit-file',
        expectedLicence: 'MIT',
        expectedLicenceMatch: 'match',
      },
    });
  });
});
