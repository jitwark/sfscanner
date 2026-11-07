import { describe, expect, it } from 'vitest';
import { decideRights, type RightsInput } from './decide.js';
import type { RightsEvidenceInput } from './evidence.js';

const ROOT_LICENCE = [{ filename: 'LICENSE', sha256: 'root-licence-hash' }];

/**
 * Evidence as a repository with a root licence instrument recorded at the
 * selected commit looks — the only basis that can carry redistribution.
 */
const SAME_COMMIT: Partial<RightsEvidenceInput> = {
  sourceCommit: 'c'.repeat(40),
  bodyHash: 'b'.repeat(40),
  rootLicence: ROOT_LICENCE,
  licenceBasis: 'same-commit-file',
};

const licenceFile = (filename: string, sha256: string) => ({ filename, sha256 });

describe('decideRights', () => {
  const allowlistedIds = [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'CC0-1.0',
    'Unlicense',
  ];

  const nonAllowlistedIds = [
    'GPL-3.0',
    'AGPL-3.0',
    'LGPL-3.0',
    'MPL-2.0',
    'EUPL-1.2',
    'Custom',
  ];

  describe('allowlisted SPDX ids', () => {
    it.each(allowlistedIds)('assigns redistributable to allowlisted licence: %s', (spdx) => {
      const res = decideRights({
        spdxId: spdx,
        workflowPath: 'workflows/test.json',
        evidence: SAME_COMMIT,
      });
      expect(res.rights.status).toBe('redistributable');
      expect(res.rights.licence).toBe(spdx);
      expect(res.rights.reason).toBe(`repository licence: ${spdx}`);
    });

    it.each(allowlistedIds)('carries the evidence the decision was made on: %s', (spdx) => {
      const res = decideRights({
        spdxId: spdx,
        workflowPath: 'workflows/test.json',
        expectedLicence: spdx,
        evidence: SAME_COMMIT,
      });
      expect(res.evidence).toMatchObject({
        workflowPath: 'workflows/test.json',
        sourceCommit: 'c'.repeat(40),
        bodyHash: 'b'.repeat(40),
        rootLicence: ROOT_LICENCE,
        licenceBasis: 'same-commit-file',
        expectedLicence: spdx,
        expectedLicenceMatch: 'match',
      });
    });
  });

  describe('non-allowlisted SPDX ids', () => {
    it.each(nonAllowlistedIds)('assigns link_only to non-allowlisted licence: %s', (spdx) => {
      const res = decideRights({
        spdxId: spdx,
        workflowPath: 'workflows/test.json',
        evidence: SAME_COMMIT,
      });
      expect(res.rights.status).toBe('link_only');
      expect(res.rights.licence).toBe(spdx);
      expect(res.rights.reason).toBe(`repository licence: ${spdx}`);
    });
  });

  it('assigns link_only for null licence', () => {
    const res = decideRights({
      spdxId: null,
      workflowPath: 'workflows/test.json',
    });
    expect(res.rights.status).toBe('link_only');
    expect(res.rights.licence).toBeNull();
    expect(res.rights.reason).toBe('no licence file');
  });

  it('assigns link_only for NOASSERTION', () => {
    const res = decideRights({
      spdxId: 'NOASSERTION',
      workflowPath: 'workflows/test.json',
      evidence: SAME_COMMIT,
    });
    expect(res.rights.status).toBe('link_only');
    expect(res.rights.licence).toBe('NOASSERTION');
    expect(res.rights.reason).toBe('repository licence: NOASSERTION');
  });

  it('assigns link_only for official n8n templates', () => {
    const res = decideRights({
      spdxId: 'MIT',
      workflowPath: 'workflows/test.json',
      sourceKind: 'n8n_official',
    });
    expect(res.rights.status).toBe('link_only');
    expect(res.rights.licence).toBeNull();
    expect(res.rights.reason).toBe('official n8n template — linked, not redistributed');
  });

  describe('contrary evidence rules', () => {
    it('quarantines when file header has copyright for a different owner', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'workflows/test.json',
        repoOwner: 'Alice',
        headerText: '/* Copyright (C) 2024 Acme Corp. All rights reserved. */',
        evidence: SAME_COMMIT,
      });
      expect(res.rights.status).toBe('excluded');
      expect(res.rights.reason).toContain('rights evidence conflict');
      expect(res.rights.reason).toContain('copyright notice for different owner');
    });

    it('quarantines when workflow is under vendor/, third_party/, or mirror/', () => {
      for (const dir of ['vendor', 'third_party', 'mirror']) {
        const res = decideRights({
          spdxId: 'MIT',
          workflowPath: `subfolder/${dir}/sample.json`,
          evidence: SAME_COMMIT,
        });
        expect(res.rights.status).toBe('excluded');
        expect(res.rights.reason).toContain(`file path under ${dir}/`);
      }
    });

    it('quarantines when README head states collection is scraped from n8n.io', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'workflows/test.json',
        readmeHead: '# n8n collection\nThis repository contains workflows scraped from n8n.io',
        evidence: SAME_COMMIT,
      });
      expect(res.rights.status).toBe('excluded');
      expect(res.rights.reason).toContain('README states collection is scraped from n8n.io');
    });

    it.each([
      'This repo is a mirror of n8n.io templates',
      'Workflows synced from n8n.io every week',
      'Templates crawled from n8n.io',
    ])('also catches other ways of saying it: %s', (readmeHead) => {
      const res = decideRights({ spdxId: 'MIT', workflowPath: 'workflows/test.json', readmeHead, evidence: SAME_COMMIT });
      expect(res.rights.status).toBe('excluded');
    });

    it('does not catch a mirror that never names its source, which is why it is not the safeguard', () => {
      // zengfr/n8n-workflow-all-templates, measured at 98.0% overlap with the
      // official library, describes itself exactly like this. A phrase list
      // cannot be the thing standing between us and republishing 10,000
      // workflows; `official-mirror.ts` compares the workflows themselves.
      const res = decideRights({
        spdxId: 'Apache-2.0',
        workflowPath: 'workflows/test.json',
        readmeHead: '# n8n-workflow-all-templates\n10258+ N8N Workflow Collection, Most comprehensive.\nsynchronized and updated every 2 months.',
        evidence: SAME_COMMIT,
      });
      expect(res.rights.status).toBe('redistributable');
    });
  });

  /**
   * Task 6.7, requirement 6. Each of these is a case where a decision that read
   * only the SPDX id would have published a record it had no evidence for: the
   * first would have published a downloadable body off a metadata-only
   * identifier, and the other three would have published a link while the
   * terms for the subtree were contradicted by a licence file we hold.
   */
  describe('redistribution evidence (task 6.7 fixtures)', () => {
    it('missing licence evidence: withholds redistribution when only repository metadata carried the identifier', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'workflows/test.json',
        expectedLicence: 'MIT',
        // No evidence passed at all: acquisition recorded no licence instrument
        // for this workflow, so the id can only have come from the REST response.
        evidence: { sourceCommit: 'c'.repeat(40), bodyHash: 'b'.repeat(40) },
      });

      expect(res.rights.status).toBe('link_only');
      expect(res.evidence.licenceBasis).toBe('metadata-only');
      expect(res.evidence.rootLicence).toEqual([]);
      expect(res.rights.reason).toContain('metadata');
    });

    it('conflicting licence evidence: quarantines when the acquired licence contradicts the configured expectation', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'workflows/test.json',
        expectedLicence: 'Apache-2.0',
        evidence: SAME_COMMIT,
      });

      expect(res.rights.status).toBe('excluded');
      expect(res.evidence.expectedLicenceMatch).toBe('mismatch');
      expect(res.rights.reason).toContain('rights evidence conflict');
      expect(res.rights.reason).toContain('expectedLicence');
    });

    it('nested licence: quarantines when an ancestor directory holds a different licence instrument', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'collection/nested/workflow.json',
        evidence: {
          ...SAME_COMMIT,
          nestedLicence: [licenceFile('collection/LICENSE', 'other-licence-hash')],
        },
      });

      expect(res.rights.status).toBe('excluded');
      expect(res.evidence.nestedLicence).toEqual([
        licenceFile('collection/LICENSE', 'other-licence-hash'),
      ]);
      expect(res.rights.reason).toContain('collection/LICENSE');
    });

    it('sibling licence: quarantines when the workflow directory holds a different licence instrument', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'collection/workflow.json',
        evidence: {
          ...SAME_COMMIT,
          siblingLicence: [licenceFile('collection/LICENSE', 'other-licence-hash')],
        },
      });

      expect(res.rights.status).toBe('excluded');
      expect(res.evidence.siblingLicence).toEqual([
        licenceFile('collection/LICENSE', 'other-licence-hash'),
      ]);
      expect(res.rights.reason).toContain('collection/LICENSE');
    });

    it('accepts a subtree licence file whose bytes are the repository licence instrument', () => {
      const res = decideRights({
        spdxId: 'MIT',
        workflowPath: 'collection/workflow.json',
        evidence: {
          ...SAME_COMMIT,
          siblingLicence: [licenceFile('collection/LICENSE', ROOT_LICENCE[0]!.sha256)],
        },
      });

      expect(res.rights.status).toBe('redistributable');
    });
  });
});

/**
 * LG-1 (audit 2026-08-25). `official-mirror.ts` demotes a workflow that also
 * exists as an official template, but it can only catch a mirror it can
 * structurally match — and a source whose connection graphs do not resolve
 * hashes on node types alone, so it never matches and the per-workflow test
 * cannot fire. When a source is known to be a collection of other people's work
 * and its copies are too mangled to be matched, the decision has to be recorded
 * on the source.
 */
describe('decideRights with a source-level redistribution withdrawal', () => {
  const withdrawal: RightsInput = {
    spdxId: 'MIT',
    workflowPath: 'workflows/example.json',
    sourceKind: 'github',
    sourceRedistribute: false,
  };

  it('withholds redistribution however permissive the licence is', () => {
    const rights = decideRights(withdrawal).rights;
    expect(rights.status).toBe('link_only');
    expect(rights.reason).toMatch(/did not author|not authored|collection/i);
  });

  it('keeps reporting the licence the repository claimed', () => {
    const rights = decideRights({
      ...withdrawal,
      licenceUrl: 'https://example.invalid/LICENSE',
    }).rights;
    expect(rights.licence).toBe('MIT');
    expect(rights.licenceUrl).toBe('https://example.invalid/LICENSE');
  });

  it('leaves every other source alone', () => {
    const rights = decideRights({
      spdxId: 'MIT',
      workflowPath: 'workflows/example.json',
      sourceKind: 'github',
      evidence: SAME_COMMIT,
    }).rights;
    expect(rights.status).toBe('redistributable');
  });
});
