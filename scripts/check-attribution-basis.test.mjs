import { describe, expect, it } from 'vitest';
import {
  auditAttributionRegister,
  auditGitIgnore,
  auditLicenceAuthority,
} from './check-attribution-basis.mjs';

const SOURCES = [
  { key: 'repo', kind: 'github', repo: 'owner/repo', expectedLicence: 'MIT', status: 'active' },
  { key: 'official', kind: 'n8n_official', expectedLicence: null, status: 'active' },
  { key: 'gone', kind: 'github', repo: 'gone/repo', expectedLicence: 'MIT', status: 'excluded' },
];

const register = ({ retained = 2, publicCount = '13,221', licence = 'MIT' } = {}) => [
  '# Attributions',
  '',
  '| Source | Declared licence | Canonical entries |',
  '| --- | --- | ---: |',
  `| [owner/repo](https://github.com/owner/repo) | ${licence} | 8 |`,
  '| [Official n8n templates](https://n8n.io/workflows/) | No asserted licence | 3 |',
  '',
  '## Excluded sources with retained credit',
  '',
  '| [gone/repo](https://github.com/gone/repo) | MIT | 2 |',
  '',
  `Active-source canonical entries: 11. Excluded-source canonical entries with retained credit: ${retained}. Total canonical entries: ${11 + retained}.`,
  '',
  `Public-tree acquisition entries: ${publicCount}. This is an acquisition count with a different basis; it is not summed with the canonical total.`,
  '',
  '## Licence authority',
  '',
  'The binding authority is MIT for code and Personal / Non-Commercial for the dataset.',
  '',
  'The public tree still carries a stale CC BY-SA 4.0 header. That is an unresolved, public-only extraction defect.',
].join('\n');

const licensing = '> Licence authority: the binding terms are MIT for code and Personal / Non-Commercial for the dataset. The public docs/REPOSITORY-MODEL.md still carries CC BY-SA 4.0 metadata.';

describe('attribution register basis', () => {
  it('accepts a register whose rows satisfy the configured sources and the corpus total', () => {
    expect(auditAttributionRegister({ sources: SOURCES, register: register(), analyticsTotal: 13 }).errors).toEqual([]);
  });

  it('rejects a dropped retained-credit row whether or not the totals were recomputed', () => {
    const staleTotals = register().replace('| [gone/repo](https://github.com/gone/repo) | MIT | 2 |\n', '');
    const recomputed = register({ retained: 0 }).replace('| [gone/repo](https://github.com/gone/repo) | MIT | 2 |\n', '');

    expect(auditAttributionRegister({ sources: SOURCES, register: staleTotals, analyticsTotal: 13 }).errors)
      .toContain('ATTRIBUTIONS.md:1: retained-credit rows sum to 0, stated 2');
    expect(auditAttributionRegister({ sources: SOURCES, register: recomputed, analyticsTotal: 13 }).errors)
      .toContain('ATTRIBUTIONS.md:1: canonical total 11 does not match data/analytics.json total 13');
  });

  it('rejects a declared licence that disagrees with pipeline/sources.json', () => {
    const { errors } = auditAttributionRegister({ sources: SOURCES, register: register({ licence: 'Apache-2.0' }), analyticsTotal: 13 });

    expect(errors).toContain('ATTRIBUTIONS.md:1: owner/repo licence does not match pipeline/sources.json');
  });

  it('rejects an acquisition count presented on the canonical basis', () => {
    const { errors } = auditAttributionRegister({ sources: SOURCES, register: register({ publicCount: '13' }), analyticsTotal: 13 });

    expect(errors).toContain('ATTRIBUTIONS.md:1: public acquisition basis is missing');
  });
});

describe('licence authority recording', () => {
  it('requires both the binding grant and the unresolved public defect', () => {
    expect(auditLicenceAuthority({ register: register(), licensing })).toEqual([]);
    expect(auditLicenceAuthority({ register: register().replace('unresolved, public-only extraction defect', 'fixed'), licensing }))
      .toContain('ATTRIBUTIONS.md:1: public metadata defect is not marked unresolved');
    expect(auditLicenceAuthority({ register: register(), licensing: 'MIT only.' }))
      .toContain('docs/LICENSING.md:1: public stale-header note is missing');
  });
});

describe('ignore scopes', () => {
  it('ignores scanner artifacts and root tarballs without masking tracked fixtures', () => {
    expect(auditGitIgnore()).toEqual([]);
  });
});
