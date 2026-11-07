import { describe, expect, it } from 'vitest';
import {
  auditScannerDocs,
  loadScannerDocs,
  renderRuleReference,
} from './lib/scanner-doc-consistency.mjs';

const current = loadScannerDocs();

function withInventory(policyInventory) {
  return { ...current, policyInventory };
}

function withReference(ruleReference) {
  return { ...current, ruleReference };
}

describe('scanner documentation consistency gate', () => {
  it('accepts the current catalogue, inventory, contracts, and generated reference', () => {
    const result = auditScannerDocs(current);

    expect(result.errors).toEqual([]);
    expect(current.ruleReference).toBe(
      renderRuleReference(current.catalogue, current.diagnosticCodes, current.limits),
    );
  });

  it('reports a missing and an extra documented policy ID', () => {
    const inventory = current.policyInventory
      .replace('| Both | `N8N_CODE_NODE` |', '| Both | `REMOVED_POLICY` |')
      .replace('\n## Analyzer and diagnostic contract', '\n| Both | `EXTRA_POLICY` |\n\n## Analyzer and diagnostic contract');
    const result = auditScannerDocs(withInventory(inventory));

    expect(result.errors).toEqual(expect.arrayContaining([
      'policy inventory is missing policy ID: N8N_CODE_NODE',
      'policy inventory has extra policy ID: EXTRA_POLICY',
    ]));
  });

  it('reports profile-count drift from the runtime catalogue', () => {
    const inventory = current.policyInventory.replace('| `beta-default` | 7 |', '| `beta-default` | 6 |');
    const result = auditScannerDocs(withInventory(inventory));

    expect(result.errors).toContain('profile beta-default documents 6 policies; runtime catalogue has 7');
  });

  it('reports a diagnostic code missing from the inventory', () => {
    const inventory = current.policyInventory.replace('`POLICY_EXECUTION_FAILED`', '`POLICY_EXECUTION_OMITTED`');
    const result = auditScannerDocs(withInventory(inventory));

    expect(result.errors).toContain('policy inventory is missing diagnostic ID: POLICY_EXECUTION_FAILED');
  });

  it.each([
    ['limits', '<!-- scanner-docs:limits -->'],
    ['privacy', '<!-- scanner-docs:privacy -->'],
    ['SARIF', '<!-- scanner-docs:sarif -->'],
    ['version', '<!-- scanner-docs:version -->'],
  ])('reports a missing %s anchor', (_name, marker) => {
    const result = auditScannerDocs(withReference(current.ruleReference.replace(marker, '')));

    expect(result.errors).toContain(`rule reference is missing ${_name} anchor`);
  });

  it('renders the generated reference deterministically', () => {
    const first = renderRuleReference(current.catalogue, current.diagnosticCodes, current.limits);
    const second = renderRuleReference(current.catalogue, current.diagnosticCodes, current.limits);

    expect(first).toBe(second);
    expect(first.split('\n').length).toBeLessThan(400);
  });
});
