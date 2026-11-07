import { describe, expect, it } from 'vitest';
import type { AnalysisDiagnosticCode } from '../policy/policy';
import { ANALYSIS_DIAGNOSTIC_COMPLETENESS } from '../result/analysis-completeness';
import {
  DIAGNOSTIC_REGISTRY,
  DIAGNOSTIC_CODES_V2,
  classifyDiagnostic,
  type DiagnosticCodeV2,
} from './registry';

// The v1 diagnostic union is FROZEN. `AnalysisDiagnosticCode` (policy/policy.ts) is the v1
// union that docs/decisions/scanner-v1-projection.md decides not to widen ("The upgraded
// validator ... does not widen the frozen v1 diagnostic union or category union"), explicitly
// rejects widening ("Map every v2 diagnostic to a new v1 category or code"), and gates behind
// "Any registry addition requires new versioned goldens and a review of this ADR".
// REQUIRED_STAGE_FAILURE was admitted as the 17th member by the recorded Slice-0 decision in
// docs/audit/2026-09-16-fix/PHASE1-LEDGER.md, section "Slice-0 ADR decision
// (REQUIRED_STAGE_FAILURE vs frozen v1 union)": it is emitted only by native v1 taint/secret
// paths that never cross the v2->v1 projection boundary, so the crosswalk row is SAME and
// projection stays identity rather than a new encoding.
// Any further member must land in ONE diff with (a) a ledger entry citing that decision, (b) the
// CLI validator vocabulary (pipeline/cli/cli-result-schema.ts + INDETERMINATE_CODES) and both
// published enum schemas (pipeline/cli/schemas/scanner-cli-v1.schema.json,
// schemas/scanner-result-v2.schema.json) extended with it, and (c) a differential golden showing
// old and new output. The count below is pinned deliberately and fails until all three are done.
const FROZEN_V1_UNION_SIZE = 17;

describe('frozen v1 diagnostic union', () => {
  it('stays closed at the reviewed size until the ADR evidence lands', () => {
    // ANALYSIS_DIAGNOSTIC_COMPLETENESS is declared Record<AnalysisDiagnosticCode, ...>, so a new
    // union member cannot compile without appearing here: its keys are the runtime view of the
    // union and let the count be pinned by an ordinary test.
    expect(
      Object.keys(ANALYSIS_DIAGNOSTIC_COMPLETENESS),
      'The frozen v1 diagnostic union changed. Before adding a member, record a ledger entry in docs/audit/2026-09-16-fix/PHASE1-LEDGER.md citing "Slice-0 ADR decision (REQUIRED_STAGE_FAILURE vs frozen v1 union)", extend the CLI validator and both schema enums in the same diff, and land a differential golden (docs/decisions/scanner-v1-projection.md, Phase 3 gate).',
    ).toHaveLength(FROZEN_V1_UNION_SIZE);
  });
});

/**
 * The registry table itself is checked against
 * `openspec/changes/world-class-scanner-cli/diagnostic-and-exit-registry.md` by
 * `scripts/diagnostic-registry.test.mjs`, which fails when the table gains a row that the
 * generated module does not have (and vice versa). This file therefore asserts the registry's
 * module-level invariants and its resolved mapping rather than restating the table, which is
 * what used to drift.
 */
describe('closed v2 diagnostic registry', () => {
  it('exposes one frozen entry per code, in registry order', () => {
    expect(DIAGNOSTIC_REGISTRY.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DIAGNOSTIC_REGISTRY)).toBe(true);
    expect(DIAGNOSTIC_REGISTRY.every((row) => Object.isFrozen(row))).toBe(true);
    const codes = DIAGNOSTIC_REGISTRY.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...DIAGNOSTIC_CODES_V2]).toEqual(codes);
    expect(DIAGNOSTIC_REGISTRY.some((row) => (row.code as string) === 'DUPLICATE_JSON_KEY')).toBe(false);
  });

  it('uses fixed classifications and both capability-requiredness branches', () => {
    expect(classifyDiagnostic('OPTIONAL_LIMIT_EXCEEDED')).toEqual({
      category: 'LIMIT', aggregateEffect: 'DEGRADED', assessmentEligible: true,
    });
    expect(classifyDiagnostic('REQUIRED_LIMIT_EXCEEDED', false)).toEqual({
      category: 'LIMIT', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    expect(classifyDiagnostic('REQUIRED_LIMIT_EXCEEDED', true)).toEqual({
      category: 'LIMIT', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    expect(classifyDiagnostic('JAVASCRIPT_PARSE_FAILED', true)).toEqual({
      category: 'PARSER', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    expect(classifyDiagnostic('JAVASCRIPT_PARSE_FAILED', false)).toEqual({
      category: 'PARSER', aggregateEffect: 'DEGRADED', assessmentEligible: true,
    });
    expect(Object.isFrozen(classifyDiagnostic('SOURCE_SPAN_UNAVAILABLE'))).toBe(true);
  });

  it('resolves the fixed effect for the one row that is fixed rather than capability-dependent', () => {
    const code: AnalysisDiagnosticCode = 'REQUIRED_STAGE_FAILURE';
    expect(DIAGNOSTIC_CODES_V2).toContain(code);
    expect(DIAGNOSTIC_CODES_V2.filter((entry) => entry === code)).toHaveLength(1);
    expect(ANALYSIS_DIAGNOSTIC_COMPLETENESS[code]).toBe('INDETERMINATE');
    // Explicit classification rather than a BY_CAPABILITY row: a required stage that failed is
    // indeterminate whatever the owning capability's requiredness says, so the classification
    // must not depend on the caller passing - or remembering to pass - that flag.
    expect(classifyDiagnostic(code)).toEqual({
      category: 'POLICY', aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
    });
    expect(classifyDiagnostic(code, true)).toEqual(classifyDiagnostic(code, false));
    const row = DIAGNOSTIC_REGISTRY.find((entry) => entry.code === code);
    expect(row).toEqual({
      code, category: 'POLICY', aggregateEffect: 'INDETERMINATE',
      assessmentEligible: false, v1Code: 'REQUIRED_STAGE_FAILURE', v1Projection: 'SAME',
    });
  });

  it('rejects unknown codes and missing fixed requiredness without leaking input', () => {
    const secret = 'secret-source-or-exception-text';
    expect(() => classifyDiagnostic(secret as DiagnosticCodeV2)).toThrow(TypeError);
    expect(() => classifyDiagnostic('JAVASCRIPT_PARSE_FAILED')).toThrow(TypeError);
    try {
      classifyDiagnostic(secret as DiagnosticCodeV2);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
