import { describe, expect, it } from 'vitest';
import {
  buildNeedles,
  collectCandidates,
  createCandidateIndex,
  isLiteralValue,
  isLoosePlaceholder,
  LOOSE_RULE,
  partitionCandidates,
  STRICT_RULES,
  summarizeCandidates,
} from './published-secret-candidates.mjs';

/**
 * Every fixture value here is synthetic and was never drawn from the corpus.
 * They are built from an alphabet that excludes the letters of every
 * placeholder word the extractor knows ("add", "put", "test", "your", …), so
 * the fixtures exercise the rules rather than the filters.
 */
const BASIC_VALUE = 'Basic qqbbjjvvww0123456789';
const BEARER_VALUE = 'Bearer xxzzqqbbjjvv0123456789';
const CREDENTIAL_USER = 'qqvvbbjj';
const CREDENTIAL_PASSWORD = 'wwxxzz0123456789';

function syntheticBody(overrides = {}) {
  return {
    nodes: [
      {
        name: 'HTTP Request',
        parameters: {
          headerParameters: {
            parameters: [
              { name: 'Authorization', value: BASIC_VALUE },
              { name: 'Authorization', value: BEARER_VALUE },
              { name: 'Authorization', value: '={{ $json.token }}' },
              { name: 'X-Api-Key', value: '<YOUR_API_KEY>' },
            ],
          },
        },
        credentials: {
          httpBasicAuth: { id: 'cred-1', name: 'Credential', user: CREDENTIAL_USER, password: CREDENTIAL_PASSWORD },
        },
        ...overrides,
      },
    ],
  };
}

function extract(body = syntheticBody()) {
  const index = collectCandidates(body, 'official__1_synthetic.json', createCandidateIndex());
  return { index, needles: buildNeedles(index), ...partitionCandidates(index) };
}

describe('published secret candidate extraction', () => {
  it('classifies a literal Basic header value as strict and as a loose pair', () => {
    const { index } = extract();
    const entry = index.get(BASIC_VALUE);
    expect([...entry.rules].sort()).toEqual([LOOSE_RULE, STRICT_RULES.BASIC_HEADER].sort());
    expect([...entry.fieldPaths]).toEqual(['workflow.nodes[].parameters.headerParameters.parameters[].value']);
  });

  it('classifies a literal Bearer header value as strict and as a loose pair', () => {
    const { index } = extract();
    expect([...index.get(BEARER_VALUE).rules].sort()).toEqual([LOOSE_RULE, STRICT_RULES.BEARER_HEADER].sort());
  });

  /**
   * An n8n expression is resolved at run time, so it stores no literal. It is
   * still kept by the widened sweep — that set is name-shaped, not value-shaped —
   * but it must never be asserted on as "a secret".
   */
  it('drops an expression from strict while the widened sweep keeps it', () => {
    const { index, strict, loose } = extract();
    expect(index.get('={{ $json.token }}').rules.has(STRICT_RULES.BASIC_HEADER)).toBe(false);
    expect(index.get('={{ $json.token }}').rules.has(LOOSE_RULE)).toBe(true);
    expect(strict.some((candidate) => candidate.entry.value === '={{ $json.token }}')).toBe(false);
    expect(loose.map((candidate) => candidate.entry.value)).toContain('={{ $json.token }}');
  });

  it('rejects a value that opens like a documentation placeholder from both sets', () => {
    const { index } = extract();
    expect(index.has('<YOUR_API_KEY>')).toBe(false);
    expect(isLoosePlaceholder('<YOUR_API_KEY>')).toBe(true);
    expect(isLiteralValue('<YOUR_API_KEY>')).toBe(false);
  });

  /**
   * The corpus currently carries one body whose `httpBasicAuth` block holds a
   * literal `user` and `password` — and both are documentation placeholders,
   * which is why the strict class finds nothing in the real corpus. The rule
   * still has to work, or a future real value would be missed.
   */
  it('records literal credential-block values under the strict credential class', () => {
    const { index } = extract();
    expect([...index.get(CREDENTIAL_USER).rules]).toEqual([STRICT_RULES.CREDENTIAL_VALUE]);
    expect([...index.get(CREDENTIAL_USER).fieldPaths]).toEqual(['workflow.nodes[].credentials.httpBasicAuth.user']);
    expect([...index.get(CREDENTIAL_PASSWORD).fieldPaths]).toEqual(['workflow.nodes[].credentials.httpBasicAuth.password']);
  });

  it('reads a credential reference as a reference, not as a value', () => {
    const body = { nodes: [{ credentials: { httpBasicAuth: { id: 'cred-1', name: 'Website credential' } } }] };
    expect(extract(body).index.size).toBe(0);
  });

  it('partitions by the strict rules, so a strict value is never counted twice', () => {
    const { strict, loose } = extract();
    expect(strict.map((candidate) => candidate.entry.value).sort()).toEqual(
      [BASIC_VALUE, BEARER_VALUE, CREDENTIAL_USER, CREDENTIAL_PASSWORD].sort(),
    );
    expect(loose).toHaveLength(1);
    expect(strict.flatMap((candidate) => candidate.strictRules)).toContain(STRICT_RULES.CREDENTIAL_VALUE);
  });

  it('builds needles in one deterministic order with positional ids', () => {
    const first = extract().needles;
    const second = extract().needles;
    expect(first.map((needle) => needle.value)).toEqual(second.map((needle) => needle.value));
    expect(first.map((needle) => needle.id)).toEqual(first.map((_, index) => index));
  });

  it('summarizes field paths and bodies without exposing a value', () => {
    const summary = summarizeCandidates(extract().index);
    expect(summary.distinctValues).toBe(5);
    expect(summary.sources).toEqual(['official__1_synthetic.json']);
    expect(summary.fieldPaths).toContain('workflow.nodes[].credentials.httpBasicAuth.password');
    expect(JSON.stringify(summary)).not.toContain(BASIC_VALUE);
    expect(JSON.stringify(summary)).not.toContain(CREDENTIAL_PASSWORD);
  });

  it('ignores a body that is not an object', () => {
    expect(collectCandidates(null, 'x.json', createCandidateIndex()).size).toBe(0);
    expect(collectCandidates('nope', 'x.json', createCandidateIndex()).size).toBe(0);
  });
});
