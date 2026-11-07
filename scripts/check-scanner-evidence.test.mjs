import { describe, expect, it } from 'vitest';
import {
  EXPECTED_ARTIFACTS,
  REQUIRED_RESEARCH_IDS,
  validateEvidenceLedger,
} from './check-scanner-evidence.mjs';

const artifactMap = Object.fromEntries(EXPECTED_ARTIFACTS.map((artifact) => [artifact.id, artifact.sha256]));
const row = (id) => `| ${id} | MD-20260905 | finding | requirement | task | gate | preserve | planned |`;
const ledger = [
  '# Evidence ledger',
  ...EXPECTED_ARTIFACTS.map((artifact) => `- ${artifact.id}: ${artifact.sha256}`),
  '| ID | Source(s) | Finding | OpenSpec requirement | Task | Focused test/gate | Disposition | Status |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...REQUIRED_RESEARCH_IDS.map(row),
].join('\n');

describe('scanner evidence gate', () => {
  it('accepts the complete ledger when artifact hashes are verified', () => {
    expect(validateEvidenceLedger(ledger, {
      artifactDigests: artifactMap,
      fileDigests: artifactMap,
    })).toEqual({ ok: true, errors: [] });
  });

  it('validates embedded identities without machine-local research files', () => {
    expect(validateEvidenceLedger(ledger, { artifactDigests: artifactMap })).toEqual({ ok: true, errors: [] });
  });

  it('rejects a missing disposition and a mismatched source digest', () => {
    const changed = ledger
      .replace(`${REQUIRED_RESEARCH_IDS[0]} | MD-20260905 | finding | requirement | task | gate | preserve | planned`, `${REQUIRED_RESEARCH_IDS[0]} | MD-20260905 | finding | requirement | task | gate |  | planned`)
      .replace(EXPECTED_ARTIFACTS[1].sha256, '0'.repeat(64));
    expect(validateEvidenceLedger(changed, {
      artifactDigests: artifactMap,
      fileDigests: { ...artifactMap, [EXPECTED_ARTIFACTS[1].id]: '0'.repeat(64) },
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        `${EXPECTED_ARTIFACTS[1].id} ledger digest does not match the approved digest`,
        `${REQUIRED_RESEARCH_IDS[0]} has an empty disposition`,
      ]),
    });
  });
});
