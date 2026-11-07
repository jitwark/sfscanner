import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { makeFact } from '../capabilities/adapter-evidence';
import { createSafeFactAdmissionSnapshotV2, ParserOwnedAdmissionBoundaryV2 } from '../admission/snapshot';
import type { SafeFactV2 } from '../capabilities/scheduler';
import type { ReadonlySourceDocumentV2 } from '../source/source-types';
import { compareNativeAndDeclarative } from './native-differential';

const encoder = new TextEncoder();
const fixtureJson = Object.freeze({
  clean: '{"nodes":[],"connections":{}}',
  risky: '{"nodes":[{"id":"http-1","name":"Call unknown API","type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://unapproved.example/v1/events"}}],"connections":{}}',
  unknown: '{"nodes":[{"id":"http-1","name":"Dynamic API","type":"n8n-nodes-base.httpRequest","parameters":{"url":"={{ $json.endpoint }}"}}],"connections":{}}',
});

type FixtureName = 'clean' | 'risky' | 'unknown';

function fixtureWorkflow(name: FixtureName): ReadonlySourceDocumentV2 {
  const admitted = ParserOwnedAdmissionBoundaryV2.fromBoundedBytes(encoder.encode(fixtureJson[name]), DEFAULT_SCANNER_LIMITS_V2);
  if (!admitted.ok) throw new Error(`fixture workflow was rejected: ${name}`);
  return admitted.snapshot;
}

function fixtureFacts(name: FixtureName): readonly SafeFactV2[] {
  const workflow = fixtureWorkflow(name);
  const hostname = name === 'clean' ? 'api.trusted.example' : name === 'risky' ? 'unapproved.example' : null;
  const fact = makeFact('destination.v2', { kind: 'SOURCE', source: workflow.root.ref }, {
    parameterPath: '/nodes/0/parameters/url',
    scheme: 'https',
    hostname,
    authorityState: name === 'unknown' ? 'UNKNOWN' : 'KNOWN',
    valueMode: name === 'unknown' ? 'DYNAMIC' : 'LITERAL',
  });
  return Object.freeze([createSafeFactAdmissionSnapshotV2(fact)]);
}

describe('UNAPPROVED_DOMAIN differential eligibility', () => {
  it('does not migrate a scoring rule as report-only', () => {
    for (const fixture of ['clean', 'risky', 'unknown'] as const) {
      const result = compareNativeAndDeclarative(
        'UNAPPROVED_DOMAIN', fixtureWorkflow(fixture), fixtureFacts(fixture),
      );
      expect(result).toEqual({
        status: 'NOT_ELIGIBLE',
        ruleId: 'UNAPPROVED_DOMAIN',
        reason: 'SCORING_AUTHORITY',
      });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });
});
