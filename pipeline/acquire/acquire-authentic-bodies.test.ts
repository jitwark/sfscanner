import { describe, expect, it } from 'vitest';
import { extractRedistributableRows } from './acquire-authentic-bodies.js';

const source = (repo: string, path: string, commit: string) => ({
  kind: 'github',
  repo,
  owner: repo.split('/')[0],
  path,
  commit,
  permalink: `https://github.com/${repo}/blob/${commit}/${path}`,
});

describe('extractRedistributableRows', () => {
  it('selects only redistributable records and sorts by pinned source identity', () => {
    const zengfr = source('zengfr/n8n-workflow-all-templates', 'z.json', 'a'.repeat(40));
    const murataslan = source('murataslan1/n8n-workflow-collection', 'm.json', 'b'.repeat(40));

    const rows = extractRedistributableRows([
      [
        { rights: { status: 'link_only' }, source: zengfr },
        { rights: { status: 'redistributable' }, source: zengfr },
      ],
      [{ rights: { status: 'redistributable' }, source: murataslan }],
    ]);

    expect(rows).toEqual([murataslan, zengfr]);
  });
});
