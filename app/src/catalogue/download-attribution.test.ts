import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../pipeline/__fixtures__/make-entry';
import { attributionFilename, buildAttribution } from './download-attribution';

describe('buildAttribution', () => {
  it('names the workflow, the licence, and where it came from', () => {
    const notice = buildAttribution(
      makeEntry({
        title: 'Sync Notion to Slack',
        rights: {
          status: 'redistributable',
          licence: 'MIT',
          licenceUrl: 'https://example.test/LICENSE',
          reason: 'repository licence: MIT',
        },
        source: {
          owner: 'octo',
          permalink: 'https://github.com/octo/flows/blob/abc/wf.json',
        },
      }),
    );

    expect(notice).toContain('Sync Notion to Slack');
    expect(notice).toContain('MIT');
    expect(notice).toContain('octo');
    expect(notice).toContain('https://github.com/octo/flows/blob/abc/wf.json');
    expect(notice).toContain('https://example.test/LICENSE');
  });

  it('names the upstream author rather than the repository owner when both are recorded', () => {
    const notice = buildAttribution(
      makeEntry({
        source: {
          owner: 'awesome-lists',
          author: { name: 'Rae Lin', username: 'raelin', url: 'https://github.com/raelin' },
        },
      }),
    );

    expect(notice).toContain('Rae Lin');
  });

  it('never claims a licence the entry does not record', () => {
    const notice = buildAttribution(
      makeEntry({
        rights: { status: 'redistributable', licence: null, licenceUrl: null, reason: 'x' },
      }),
    );

    expect(notice).not.toMatch(/\bMIT\b|Apache|BSD/);
    expect(notice).toContain('not recorded');
  });

  it('carries the sentence that makes the notice do its job', () => {
    const notice = buildAttribution(makeEntry());

    // MIT §"The above copyright notice ... shall be included in all copies".
    // A file handed over without it is a licence breach, so the obligation to
    // keep the notice with the copy has to be stated in the copy.
    expect(notice).toMatch(/must stay with/i);
  });
});

describe('attributionFilename', () => {
  it('names the file after the workflow so a folder of downloads stays legible', () => {
    expect(attributionFilename(makeEntry({ slug: 'sync-notion-to-slack-abc123' })))
      .toBe('sync-notion-to-slack-abc123.LICENSE.txt');
  });
});
