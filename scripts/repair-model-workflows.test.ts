import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceDef } from '@hub/contracts';
import { loadConfiguredSources, resolveGitDirectory } from './repair-model-workflows.js';

const runDir = path.join('pipeline', '.work', 'repair-test');

function entry(id: string, repo: string): Record<string, unknown> {
  return { id, source: { repo } };
}

describe('repair-model-workflows clone resolution', () => {
  it('resolves configured repositories to immutable source-key clone directories', () => {
    const sources = loadConfiguredSources();

    expect(resolveGitDirectory(runDir, entry('pinecone-entry', 'pinecone-io/n8n-templates'), sources)).toBe(
      path.join(runDir, 'clones', 'pinecone', '.git'),
    );
    expect(
      resolveGitDirectory(
        runDir,
        entry('creativetim-entry', 'creativetimofficial/free-n8n-workflow-templates-collection'),
        sources,
      ),
    ).toBe(path.join(runDir, 'clones', 'creativetim', '.git'));
  });

  it('fails closed when a repository mapping is absent or ambiguous', () => {
    const sources = loadConfiguredSources();
    const missingRepo = 'missing-owner/missing-repository';

    expect(() => resolveGitDirectory(runDir, entry('missing-entry', missingRepo), sources)).toThrow(
      /missing-entry.*missing-owner\/missing-repository/,
    );

    const pinecone = sources.find((source) => source.repo === 'pinecone-io/n8n-templates');
    if (!pinecone) throw new Error('pinecone fixture is missing from pipeline/sources.json');
    const ambiguousSources: SourceDef[] = [
      ...sources,
      { ...pinecone, key: 'pinecone-duplicate' },
    ];

    expect(() => resolveGitDirectory(runDir, entry('ambiguous-entry', pinecone.repo!), ambiguousSources)).toThrow(
      /ambiguous-entry.*pinecone-io\/n8n-templates.*ambiguous/,
    );
  });
});
