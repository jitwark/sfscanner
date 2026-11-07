import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../workflow';
import { unknownNodePackagePolicy } from './package-and-webhook-policies';

function packages(types: readonly string[]): string[] {
  const parsed = parseWorkflowJson(JSON.stringify({
    nodes: types.map((type, index) => ({ id: `n${index}`, name: `N${index}`, type, typeVersion: 1, parameters: {} })),
    connections: {},
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return unknownNodePackagePolicy.evaluate(parsed.workflow)
    .map((finding) => String(finding.evidence.nodePackage));
}

describe('UNKNOWN_NODE_PACKAGE deduplication', () => {
  it('reports prototype-named packages instead of inheriting a truthy key', () => {
    expect(packages(['community.alpha.one', 'community.alpha.two', 'toString.node',
      'valueOf.node', 'constructor.node', '__proto__.node']))
      .toEqual(['community', 'toString', 'valueOf', 'constructor', '__proto__']);
  });
});
