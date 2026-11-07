import { describe, expect, it } from 'vitest';
import {
  findPendingLegalFields,
  findProductionLegalReleaseFailures,
  findReleaseApprovalFailures,
  findUnsupportedLegalClaims,
  isProductionRelease,
} from './legal-identity.mjs';

async function readRepoFile(relativePath) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  return readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

describe('isProductionRelease', () => {
  it('is false when neither production env var is set (local dev, ci.yml gates job)', () => {
    expect(isProductionRelease({})).toBe(false);
  });

  it('is true when NEXT_PUBLIC_BASE_PATH is set (deploy.yml)', () => {
    expect(isProductionRelease({ NEXT_PUBLIC_BASE_PATH: '/n8n-community' })).toBe(true);
  });

  it('is true when NEXT_PUBLIC_SITE_URL is set (deploy.yml)', () => {
    expect(isProductionRelease({ NEXT_PUBLIC_SITE_URL: 'https://example.github.io/repo' })).toBe(true);
  });

  it('is true for a GitHub Actions release context even if deploy URL variables are omitted', () => {
    expect(isProductionRelease({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('is not fooled by NODE_ENV=production alone (true for every next build, including local ones)', () => {
    expect(isProductionRelease({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('findPendingLegalFields', () => {
  const FILLED_SOURCE = `
    export const operator: PendingOr<string> = 'Example Org';
    export const contactEmail: PendingOr<string> = 'legal@example.com';
    export const dmcaAgent = { name: 'Jane Doe', address: '1 Example St', phone: '+1-555-0100', email: 'dmca@example.com' };
    export const dmcaAgentRegisteredAt: PendingOr<string> = '2026-01-01';
  `;

  const PENDING_SOURCE = `
    export const operator: PendingOr<string> = PENDING;
    export const contactEmail: PendingOr<string> = PENDING;
    export const dmcaAgent = { name: PENDING, address: PENDING, phone: PENDING, email: PENDING };
    export const dmcaAgentRegisteredAt: PendingOr<string> = PENDING;
  `;

  it('passes with a valid operator and contactEmail and no jurisdiction declaration at all', () => {
    expect(findPendingLegalFields(FILLED_SOURCE)).toEqual([]);
  });

  it('does not require a designated agent when the product explicitly makes no safe-harbour claim', () => {
    const noAgentSource = PENDING_SOURCE
      .replace('export const operator: PendingOr<string> = PENDING;', "export const operator: PendingOr<string> = 'Example Org';")
      .replace('export const contactEmail: PendingOr<string> = PENDING;', "export const contactEmail: PendingOr<string> = 'legal@example.com';");

    expect(findPendingLegalFields(noAgentSource)).toEqual([]);
  });

  it('reports required identity fields but ignores the optional no-safe-harbour agent block', () => {
    const failures = findPendingLegalFields(PENDING_SOURCE);
    expect(failures).toContain('operator is still PENDING');
    expect(failures).toContain('contactEmail is still PENDING');
    expect(failures).toHaveLength(2);
  });

  it('reports only the one field that is still PENDING when the rest are filled', () => {
    const mixedSource = FILLED_SOURCE.replace(
      "export const contactEmail: PendingOr<string> = 'legal@example.com';",
      'export const contactEmail: PendingOr<string> = PENDING;',
    );
    expect(findPendingLegalFields(mixedSource)).toEqual(['contactEmail is still PENDING']);
  });

  it('treats a quoted PENDING sentinel as a placeholder too', () => {
    const quotedSource = FILLED_SOURCE.replace(
      "export const contactEmail: PendingOr<string> = 'legal@example.com';",
      "export const contactEmail: PendingOr<string> = 'PENDING';",
    );
    expect(findPendingLegalFields(quotedSource)).toEqual(['contactEmail is still PENDING']);
  });

  it('rejects blank required legal identity fields without requiring agent registration', () => {
    const blankSource = FILLED_SOURCE
      .replace("'Example Org'", "'   '")
      .replace("'2026-01-01'", "'2022-01-01'");
    const failures = findPendingLegalFields(blankSource, new Date('2026-08-29T00:00:00Z'));
    expect(failures).toContain('operator is blank');
    expect(failures).not.toContain('dmcaAgentRegisteredAt is invalid or expired');
  });

  it('fails loud (as a failure) rather than silently passing when a field cannot be located at all', () => {
    const truncatedSource = "export const operator: PendingOr<string> = 'Example Org';";
    const failures = findPendingLegalFields(truncatedSource);
    expect(failures).toEqual(['contactEmail: could not locate its declaration in legal-contacts.ts']);
  });

  it('matches the real legal-contacts.ts file today (operator and contact published, no jurisdiction field)', async () => {
    const source = await readRepoFile('app/src/ui/legal/legal-contacts.ts');
    const failures = findPendingLegalFields(source);
    // Operator and contact are published; A4b removed the jurisdiction field
    // from the module and this gate together, and the agent block stays unfilled.
    expect(failures).toEqual([]);
  });
});

describe('findReleaseApprovalFailures', () => {
  it('requires the documented production-promotion decision to be exactly approved', () => {
    expect(findReleaseApprovalFailures('| Production promotion allowed | pending |')).toEqual([
      'Production promotion allowed is not explicitly approved',
    ]);
    expect(findReleaseApprovalFailures('| Production promotion allowed | approved |')).toEqual([]);
  });

  it('rejects negative and malformed decision values instead of treating contact as approval', () => {
    for (const value of ['no', 'not approved', 'yes', 'approved by owner']) {
      expect(findReleaseApprovalFailures(`| Production promotion allowed | ${value} |`)).toEqual([
        'Production promotion allowed is not explicitly approved',
      ]);
    }
  });

  it('fails closed when the documented decision row is missing', () => {
    expect(findReleaseApprovalFailures('| Owner decision date | pending |')).toEqual([
      'Production promotion allowed: could not locate its decision row',
    ]);
  });
});

describe('findUnsupportedLegalClaims', () => {
  // Reworded, dash-split, JSX-split and markup-split governing-law forms.
  it.each([
    '<p>Governing law: Delaware, USA</p>',
    'These terms are governed by the laws of the State of Delaware.',
    'These terms are governed-by the laws of the State of Delaware.',
    'These terms are governed—by the laws of the State of Delaware.',
    'Governing—law of Delaware applies.',
    "<p>governing{' '}law</p>",
    '<p>Governing<strong> law</strong> of Delaware applies.</p>',
  ])('fails on a reworded or split governing-law claim: %s', (termsBodySource) => {
    expect(findUnsupportedLegalClaims({ termsBodySource }))
      .toEqual(['terms body still asserts a governing law']);
  });

  it.each([
    '<ContactValue label="Jurisdiction" value={jurisdiction} />',
    '<p>Disputes are heard by the courts of Delaware.</p>',
    // Deliberate: a URL is still a claim surface in rendered copy, so this
    // check errs toward failing instead of exempting string and URL content.
    '<p><Link href="https://example.com/jurisdiction">rules</Link></p>',
    // Comment markers inside string literals are string content, not comments:
    // the real `jurisdiction` reference in this code must still fail the gate.
    "const a = 'x // y'; const b = 'jurisdiction';",
    "const a = '/* x'; const b = 'jurisdiction'; const c = '*/';",
    "const a = 'don\\'t // _'; const b = 'jurisdiction';",
    "const a = `x // y`; const b = 'jurisdiction';",
  ])('fails on a jurisdiction reference (code, string or URL): %s', (termsBodySource) => {
    expect(findUnsupportedLegalClaims({ termsBodySource }))
      .toEqual(['terms body still asserts a jurisdiction']);
  });

  it('reports both claims for a governing-law clause that also asserts venue', () => {
    expect(findUnsupportedLegalClaims({ termsBodySource: '<p>Governing-law clause: venue lies in Delaware.</p>' }))
      .toEqual(['terms body still asserts a governing law', 'terms body still asserts a jurisdiction']);
  });

  it('does not fail on the claim wording appearing only in comments', () => {
    const lineComment = '// No governing law claim and no jurisdiction are named here.\n<p>The terms.</p>';
    const blockComment = '/* No governing law claim is made here. */\n<p>The terms.</p>';
    expect(findUnsupportedLegalClaims({ termsBodySource: lineComment })).toEqual([]);
    expect(findUnsupportedLegalClaims({ termsBodySource: blockComment })).toEqual([]);
  });

  it('fails closed when the terms body source is missing or not text', () => {
    expect(findUnsupportedLegalClaims()).toEqual(['terms body: could not read its source']);
    expect(findUnsupportedLegalClaims({ termsBodySource: '   ' }))
      .toEqual(['terms body: could not read its source']);
  });

  it('passes on the real terms-body.tsx currently on disk', async () => {
    const source = await readRepoFile('app/src/ui/legal/terms-body.tsx');
    expect(findUnsupportedLegalClaims({ termsBodySource: source })).toEqual([]);
  });
});

describe('findProductionLegalReleaseFailures', () => {
  const COMPLETE_IDENTITY_SOURCE = `
    export const operator: PendingOr<string> = 'Example Org';
    export const contactEmail: PendingOr<string> = 'legal@example.com';
  `;
  const INCOMPLETE_IDENTITY_SOURCE = `
    export const operator: PendingOr<string> = PENDING;
    export const contactEmail: PendingOr<string> = PENDING;
  `;
  const CLEAN_TERMS_BODY_SOURCE = '<p>These terms are published and dated at the top of the page.</p>';
  const APPROVED_PACKET = '| Production promotion allowed | approved |';

  it('reports missing legal identity and missing approval independently', () => {
    const failures = findProductionLegalReleaseFailures({
      legalIdentitySource: INCOMPLETE_IDENTITY_SOURCE,
      decisionPacketSource: '| Production promotion allowed | pending |',
      termsBodySource: CLEAN_TERMS_BODY_SOURCE,
    });

    expect(failures).toContain('operator is still PENDING');
    expect(failures).toContain('contactEmail is still PENDING');
    expect(failures).toContain('Production promotion allowed is not explicitly approved');
  });

  it('passes only when identity is complete, the terms assert no jurisdiction, and approval is explicit', () => {
    expect(findProductionLegalReleaseFailures({
      legalIdentitySource: COMPLETE_IDENTITY_SOURCE,
      decisionPacketSource: APPROVED_PACKET,
      termsBodySource: CLEAN_TERMS_BODY_SOURCE,
    })).toEqual([]);
  });

  it('still fails on a missing production-approval row even when everything else passes', () => {
    expect(findProductionLegalReleaseFailures({
      legalIdentitySource: COMPLETE_IDENTITY_SOURCE,
      decisionPacketSource: '| Owner decision date | pending |',
      termsBodySource: CLEAN_TERMS_BODY_SOURCE,
    })).toEqual(['Production promotion allowed: could not locate its decision row']);
  });

  it('rejects a terms body that re-asserts the jurisdiction the product does not have', () => {
    expect(findProductionLegalReleaseFailures({
      legalIdentitySource: COMPLETE_IDENTITY_SOURCE,
      decisionPacketSource: APPROVED_PACKET,
      termsBodySource: '<p>Governing law: Delaware, USA</p>',
    })).toContain('terms body still asserts a governing law');
  });

  it('fails closed when the terms body source is unavailable instead of passing', () => {
    expect(findProductionLegalReleaseFailures({
      legalIdentitySource: COMPLETE_IDENTITY_SOURCE,
      decisionPacketSource: APPROVED_PACKET,
    })).toContain('terms body: could not read its source');
  });
});
