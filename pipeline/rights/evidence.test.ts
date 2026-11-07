import { describe, expect, it } from 'vitest';
import { deriveLicenceBasis, isLicenceInstrument } from './evidence.js';

const file = (filename: string) => ({ filename, sha256: 'a'.repeat(64) });

describe('isLicenceInstrument', () => {
  it.each([
    ['LICENSE', true],
    ['LICENSE.md', true],
    ['COPYING', true],
    ['COPYING.LESSER', true],
    ['docs/LICENSE', true],
    ['NOTICE', false],
    ['NOTICE.txt', false],
    ['collection/NOTICE', false],
    ['LICENCE', false],
    ['README.md', false],
  ])('classifies %s as an instrument: %s', (filename, expected) => {
    expect(isLicenceInstrument(filename)).toBe(expected);
  });
});

describe('deriveLicenceBasis', () => {
  it('takes a root licence instrument as a same-commit file', () => {
    expect(deriveLicenceBasis({ apiLicencePresent: true, licenceFiles: [file('LICENSE')] })).toBe(
      'same-commit-file',
    );
  });

  it('does not let a root NOTICE stand in for a licence instrument', () => {
    // A notice is attribution, not a grant: a repository can carry one — for a
    // vendored component inside it — while recording no licence instrument at
    // all. Reading it as the basis published a metadata-only claim as
    // same-commit evidence.
    expect(deriveLicenceBasis({ apiLicencePresent: true, licenceFiles: [file('NOTICE')] })).toBe(
      'metadata-only',
    );
    expect(deriveLicenceBasis({ apiLicencePresent: false, licenceFiles: [file('NOTICE')] })).toBe('none');
  });

  it('still takes a root instrument when a root NOTICE sits beside it', () => {
    expect(
      deriveLicenceBasis({ apiLicencePresent: false, licenceFiles: [file('NOTICE'), file('LICENSE')] }),
    ).toBe('same-commit-file');
  });

  it('does not take a nested instrument as the repository basis', () => {
    expect(deriveLicenceBasis({ apiLicencePresent: true, licenceFiles: [file('collection/LICENSE')] })).toBe(
      'metadata-only',
    );
  });

  it('reports nothing recorded as none rather than as metadata', () => {
    expect(deriveLicenceBasis({ apiLicencePresent: false, licenceFiles: [] })).toBe('none');
  });
});
