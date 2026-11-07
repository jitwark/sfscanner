import type { Entry } from '@hub/contracts';

const NOT_RECORDED = 'not recorded';

/**
 * The notice that has to travel with a redistributed workflow.
 *
 * MIT and Apache-2.0 both make carrying the copyright notice a condition of
 * redistribution, and until 2026-08-25 every download here shipped without one.
 * A workflow JSON has no comment syntax and adding a key would change the file
 * we hand over, so the notice goes out as a sibling text file instead.
 *
 * Every line is a fact already recorded on the entry. Nothing is composed,
 * inferred, or asked of a model — `docs/CONTENT-CONTRACT.md` puts a licence
 * exactly in the class of claim generated prose may never make, and an
 * attribution notice that invents its attribution is worse than none.
 */
export function buildAttribution(entry: Entry): string {
  const author = entry.source?.author?.name ?? entry.source?.owner ?? NOT_RECORDED;
  const lines = [
    `Workflow: ${entry.title}`,
    `Upstream author: ${author}`,
    `Upstream source: ${entry.source?.permalink ?? NOT_RECORDED}`,
    `Licence: ${entry.rights?.licence ?? NOT_RECORDED}`,
    `Licence text: ${entry.rights?.licenceUrl ?? NOT_RECORDED}`,
    '',
    'This workflow is redistributed under the licence named above. That licence,',
    'not this catalogue, governs what you may do with the file.',
    'This notice must stay with the copy, including any copy you pass on.',
  ];
  return `${lines.join('\n')}\n`;
}

/** `<slug>.LICENSE.txt`, so a folder of downloads pairs up on sight. */
export function attributionFilename(entry: Entry): string {
  return `${entry.slug}.LICENSE.txt`;
}
