/**
 * Frozen vectors W1-W8 from `docs/audit/2026-10-21-scanner-improvement/q02/Q02.1-ORACLE.json`.
 * Each test names the vector it pins so a failure points at the oracle entry, and the
 * determinism tests pin that input order never reaches the emitted bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  rankCoverage,
  type CandidateScope,
  type Known,
  type Requirement,
  type WorkflowNeeds,
} from './scanner-coverage-priority.js';

const VERSION: Known<string> = { state: 'KNOWN', value: '1.0.0' };

function requirement(nodeType: string, overrides: Partial<Omit<Requirement, 'nodeType'>> = {}): Requirement {
  return {
    nodeType,
    version: VERSION,
    resource: { state: 'KNOWN', value: null },
    operation: { state: 'KNOWN', value: null },
    capability: 'nodes',
    ...overrides,
  };
}

function flow(
  inputDigest: string,
  requirements: readonly Requirement[],
  eligibility: WorkflowNeeds['eligibility'] = 'ELIGIBLE',
  exclusionReason: string | null = null,
): WorkflowNeeds {
  return { inputDigest, requirements, eligibility, exclusionReason };
}

function scope(
  key: string,
  covers: readonly Requirement[],
  securityInstances = 0,
  costUnits = 1,
): CandidateScope {
  return { key, covers, securityInstances, costUnits };
}

const PREFIX = /^scanner-coverage-priority: /;

describe('W1/W2 greedy marginal ordering', () => {
  const a = requirement('n8n-nodes-base.hubspot');
  const b = requirement('n8n-nodes-base.slack');
  const needs = [flow('digest-w1', [a, b]), flow('digest-w2', [a])];
  const candidates = [scope('A', [a]), scope('B', [b])];

  it('W1 selects A first because it completes W2, then B because it completes W1', () => {
    const ranked = rankCoverage(needs, [], candidates);
    expect(ranked.map((priority) => priority.key)).toEqual(['A', 'B']);
    expect(ranked[0]).toMatchObject({ newlyComplete: 1, unresolvedRemoved: 1, securityInstances: 0, costUnits: 1 });
    expect(ranked[1]).toMatchObject({ newlyComplete: 1, unresolvedRemoved: 1, securityInstances: 0, costUnits: 1 });
  });

  it('W2 returns byte-identical output when the candidate list is reversed', () => {
    const forward = JSON.stringify(rankCoverage(needs, [], candidates));
    const reversed = JSON.stringify(rankCoverage(needs, [], [candidates[1], candidates[0]]));
    expect(reversed).toBe(forward);
  });
});

describe('W3 UNKNOWN never matches', () => {
  it('does not complete a workflow whose version is UNKNOWN even when the candidate names 1.0.0', () => {
    const unknown = requirement('n8n-nodes-base.httpRequest', {
      version: { state: 'UNKNOWN', reason: 'missing' },
    });
    const exact = requirement('n8n-nodes-base.httpRequest');
    const ranked = rankCoverage([flow('digest-w3', [unknown])], [], [scope('A', [exact])]);
    expect(ranked).toEqual([
      { key: 'A', newlyComplete: 0, unresolvedRemoved: 0, securityInstances: 0, costUnits: 1 },
    ]);
  });
});

describe('W4 known-null is a value', () => {
  const knownNull = requirement('n8n-nodes-base.set', { resource: { state: 'KNOWN', value: null } });
  const unknown = requirement('n8n-nodes-base.set', {
    resource: { state: 'UNKNOWN', reason: 'missing' },
  });

  it('matches KNOWN(null) to KNOWN(null) only, never the UNKNOWN sibling', () => {
    const ranked = rankCoverage(
      [flow('digest-known-null', [knownNull]), flow('digest-unknown-resource', [unknown])],
      [],
      [scope('A', [knownNull])],
    );
    expect(ranked[0]).toMatchObject({ newlyComplete: 1, unresolvedRemoved: 1 });
  });

  it('treats KNOWN(null) already admitted as resolved', () => {
    const ranked = rankCoverage([flow('digest-known-null', [knownNull])], [knownNull], [scope('A', [knownNull])]);
    expect(ranked[0]).toMatchObject({ newlyComplete: 0, unresolvedRemoved: 0 });
  });
});

describe('W5 duplicate workflow digest', () => {
  it('throws a typed error instead of double counting coverage', () => {
    expect(() => rankCoverage([flow('digest-same', []), flow('digest-same', [])], [], [])).toThrow(
      /^scanner-coverage-priority: duplicate workflow inputDigest/,
    );
  });
});

describe('W6 excluded rows', () => {
  const shared = requirement('n8n-nodes-base.if');

  it('validates an excluded row but keeps it out of newlyComplete', () => {
    const ranked = rankCoverage(
      [flow('digest-eligible', [shared]), flow('digest-excluded', [shared], 'EXCLUDED', 'rights: unlicensed')],
      [],
      [scope('A', [shared])],
    );
    expect(ranked[0]).toMatchObject({ newlyComplete: 1, unresolvedRemoved: 1 });
  });

  it('rejects an EXCLUDED row without a non-empty exclusionReason', () => {
    expect(() => rankCoverage([flow('digest-excluded', [], 'EXCLUDED', null)], [], [])).toThrow(
      /^scanner-coverage-priority: .*exclusionReason/,
    );
  });
});

describe('W7 tie order', () => {
  const a = requirement('n8n-nodes-base.code');
  const b = requirement('n8n-nodes-base.wait');

  it('breaks a full tie by key code units and ignores candidate order', () => {
    const needs = [flow('digest-tie', [a, b])];
    const forward = rankCoverage(needs, [], [scope('B', [b]), scope('A', [a])]);
    expect(forward.map((priority) => priority.key)).toEqual(['A', 'B']);
    expect(JSON.stringify(rankCoverage(needs, [], [scope('A', [a]), scope('B', [b])]))).toBe(
      JSON.stringify(forward),
    );
  });
});

describe('W8 UNKNOWN in coverage', () => {
  const unknown = requirement('n8n-nodes-base.merge', {
    operation: { state: 'UNKNOWN', reason: 'dynamic' },
  });
  const known = requirement('n8n-nodes-base.merge');

  it('rejects UNKNOWN in a candidate scope', () => {
    expect(() => rankCoverage([], [], [scope('A', [unknown])])).toThrow(
      /^scanner-coverage-priority: UNKNOWN is not valid candidate coverage/,
    );
  });

  it('rejects UNKNOWN in an admitted requirement', () => {
    expect(() => rankCoverage([], [unknown], [])).toThrow(
      /^scanner-coverage-priority: UNKNOWN is not valid admitted coverage/,
    );
  });
});

describe('revision 1 guards', () => {
  const a = requirement('n8n-nodes-base.splitInBatches');

  it('counts duplicate requirement encodings once per workflow and candidate', () => {
    const ranked = rankCoverage([flow('digest-dedupe', [a, a])], [], [scope('A', [a, a])]);
    expect(ranked[0]).toMatchObject({ newlyComplete: 1, unresolvedRemoved: 1 });
  });

  it('rejects duplicate candidate keys', () => {
    expect(() => rankCoverage([], [], [scope('A', []), scope('A', [])])).toThrow(
      /^scanner-coverage-priority: duplicate candidate key/,
    );
  });

  it('rejects holes in needs, admitted, candidates and requirement arrays', () => {
    const sparseNeeds: WorkflowNeeds[] = [flow('digest-sparse-needs', [a])];
    const sparseAdmitted: Requirement[] = [a];
    const sparseCandidates: CandidateScope[] = [scope('A', [a])];
    const sparseRequirements: Requirement[] = [a];
    const sparseCovers: Requirement[] = [a];
    for (const sparse of [sparseNeeds, sparseAdmitted, sparseCandidates, sparseRequirements, sparseCovers]) {
      sparse.length = 2;
    }
    expect(() => rankCoverage(sparseNeeds, [], [])).toThrow(/^scanner-coverage-priority: .*holes/);
    expect(() => rankCoverage([], sparseAdmitted, [])).toThrow(/^scanner-coverage-priority: .*holes/);
    expect(() => rankCoverage([], [], sparseCandidates)).toThrow(/^scanner-coverage-priority: .*holes/);
    expect(() => rankCoverage([flow('digest-sparse-requirements', sparseRequirements)], [], [])).toThrow(
      /^scanner-coverage-priority: .*holes/,
    );
    expect(() => rankCoverage([], [], [scope('A', sparseCovers)])).toThrow(
      /^scanner-coverage-priority: .*holes/,
    );
  });

  it('rejects non-index properties on input arrays', () => {
    const withExtra = Object.assign([flow('digest-extra', [a])], { extra: 1 });
    expect(() => rankCoverage(withExtra, [], [])).toThrow(
      /^scanner-coverage-priority: .*non-index properties/,
    );
  });
});

describe('array index boundary', () => {
  const a = requirement('n8n-nodes-base.splitInBatches');

  it('rejects an own property keyed 4294967295, which is not a JavaScript array index', () => {
    const beyondIndex = Object.assign([flow('digest-max-index', [a])], {
      4294967295: requirement('n8n-nodes-base.slack'),
    });
    expect(() => rankCoverage(beyondIndex, [], [])).toThrow(
      /^scanner-coverage-priority: .*non-index properties/,
    );
  });

  it('accepts a dense array with ordinary indices', () => {
    const ranked = rankCoverage([flow('digest-dense', [a])], [], [scope('A', [a])]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ key: 'A', newlyComplete: 1, unresolvedRemoved: 1 });
  });

  it('accepts a JSON-decoded dense array', () => {
    const needs = JSON.parse(JSON.stringify([flow('digest-json', [a])])) as WorkflowNeeds[];
    const candidates = JSON.parse(JSON.stringify([scope('A', [a])])) as CandidateScope[];
    expect(() => rankCoverage(needs, [], candidates)).not.toThrow();
    expect(rankCoverage(needs, [], candidates)[0]).toMatchObject({ key: 'A', newlyComplete: 1 });
  });
});

describe('determinism and output shape', () => {
  it('emits the same bytes when needs, admitted and candidates are reordered', () => {
    const first = requirement('n8n-nodes-base.hubspot');
    const second = requirement('n8n-nodes-base.slack');
    const admitted = [
      requirement('n8n-nodes-base.set'),
      requirement('n8n-nodes-base.noOp'),
    ];
    const needs = [flow('digest-b', [first, second]), flow('digest-a', [second])];
    const candidates = [scope('B', [second]), scope('A', [first]), scope('C', [second], 2, 0)];

    const reorderedNeeds = [flow('digest-a', [second]), flow('digest-b', [second, first])];
    const ranked = rankCoverage(needs, admitted, candidates);
    const reordered = rankCoverage(reorderedNeeds, [...admitted].reverse(), [...candidates].reverse());
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(ranked));
    expect(ranked).toHaveLength(candidates.length);
    expect(new Set(ranked.map((priority) => priority.key)).size).toBe(candidates.length);
    expect(Object.isFrozen(ranked)).toBe(true);
    expect(ranked.every((priority) => Object.isFrozen(priority))).toBe(true);
  });

  it('sanitizes and bounds input strings', () => {
    expect(() => rankCoverage([flow('digest-nfde\u0301', [])], [], [])).toThrow(
      /^scanner-coverage-priority: .*NFC/,
    );
    expect(() => rankCoverage([], [], [scope('', [])])).toThrow(/^scanner-coverage-priority: .*empty/);
    expect(() => rankCoverage([], [], [scope('A', [requirement('n'.repeat(513))])])).toThrow(PREFIX);
    expect(() => rankCoverage([], [], [scope('A', [], -1, 0)])).toThrow(PREFIX);
  });
});
