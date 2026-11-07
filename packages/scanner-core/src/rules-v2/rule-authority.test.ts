import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_REGISTRY, classifyDiagnostic } from '../diagnostics/registry';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import {
  RULE_AUTHORITY_FIELDS_V2, UNKNOWN_RULE_DIAGNOSTIC_V2, admittedRuleV2, resolveDeclaredRulesV2,
  resolveRuleAuthorityV2, ruleAuthorityMatchesV2, unknownRuleCaseV2,
} from './rule-authority';
import type { AdmittedRuleV2 } from '../capabilities/scheduler';

const admitted = createAdmittedRuleView().rules;
const rule = admitted.get('N8N_CODE_NODE');
if (rule === undefined) throw new Error('fixture rule authority is incomplete');
const required = { required: true }; const optional = { required: false };

/** The scheduler's frozen immutable map view, hand-built from the same shape. */
function immutableView(entries: readonly (readonly [string, AdmittedRuleV2])[]): ReadonlyMap<string, AdmittedRuleV2> {
  const source = new Map(entries);
  const view = Object.create(null) as Record<PropertyKey, unknown>;
  Object.assign(view, {
    size: source.size, get: (key: string) => source.get(key), has: (key: string) => source.has(key),
    entries: () => source.entries(), keys: () => source.keys(), values: () => source.values(),
    forEach: (callback: (value: AdmittedRuleV2, key: string) => void) => source.forEach(callback),
    set: () => view, delete: () => false, clear: () => undefined, [Symbol.iterator]: () => source.entries(),
  });
  return Object.freeze(view) as unknown as ReadonlyMap<string, AdmittedRuleV2>;
}

describe('unknown rule authority', () => {
  it('fails closed for every case that is not provably report-only', () => {
    expect(unknownRuleCaseV2(required)).toBe('SCORING');
    expect(unknownRuleCaseV2(optional)).toBe('REPORT_ONLY');
    expect(unknownRuleCaseV2(undefined)).toBe('SCORING');
  });

  it('maps the two cases onto the registry effects the split relies on', () => {
    const scoring = DIAGNOSTIC_REGISTRY.find((entry) => entry.code === UNKNOWN_RULE_DIAGNOSTIC_V2.SCORING);
    const reportOnly = DIAGNOSTIC_REGISTRY.find((entry) => entry.code === UNKNOWN_RULE_DIAGNOSTIC_V2.REPORT_ONLY);
    expect(scoring).toMatchObject({ aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    expect(reportOnly).toMatchObject({ aggregateEffect: 'DEGRADED', assessmentEligible: true });
    expect(classifyDiagnostic('UNKNOWN_SCORING_RULE', true)).toMatchObject({ aggregateEffect: 'INDETERMINATE', assessmentEligible: false });
    expect(classifyDiagnostic('UNKNOWN_REPORT_ONLY_RULE', true)).toMatchObject({ aggregateEffect: 'DEGRADED', assessmentEligible: true });
  });

  it('resolves an admitted rule and classifies an unadmitted one by its declared owner', () => {
    expect(resolveRuleAuthorityV2(admitted, 'N8N_CODE_NODE')).toEqual({ ok: true, rule });
    expect(resolveRuleAuthorityV2(admitted, 'NOT_AN_ADMITTED_RULE', required)).toMatchObject({ ok: false, ruleId: 'NOT_AN_ADMITTED_RULE', case: 'SCORING', diagnosticCode: 'UNKNOWN_SCORING_RULE' });
    expect(resolveRuleAuthorityV2(admitted, 'NOT_AN_ADMITTED_RULE', optional)).toMatchObject({ ok: false, case: 'REPORT_ONLY', diagnosticCode: 'UNKNOWN_REPORT_ONLY_RULE' });
    expect(resolveRuleAuthorityV2(admitted, 'NOT_AN_ADMITTED_RULE')).toMatchObject({ ok: false, case: 'SCORING' });
  });

  it('refuses a declaration the catalogue only partly carries', () => {
    const resolved = resolveDeclaredRulesV2(['N8N_CODE_NODE'], admitted, required);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect([...resolved.rules.keys()]).toEqual(['N8N_CODE_NODE']);
    expect(resolveDeclaredRulesV2(['N8N_CODE_NODE', 'NOT_AN_ADMITTED_RULE'], admitted, optional)).toMatchObject({ ok: false, ruleId: 'NOT_AN_ADMITTED_RULE', case: 'REPORT_ONLY' });
  });

  it('reads a real map and the frozen immutable view, and refuses anything else', () => {
    expect(admittedRuleV2(new Map([['N8N_CODE_NODE', rule]]), 'N8N_CODE_NODE')).toBe(rule);
    expect(admittedRuleV2(immutableView([['N8N_CODE_NODE', rule]]), 'N8N_CODE_NODE')).toBe(rule);
    expect(admittedRuleV2(immutableView([['N8N_CODE_NODE', rule]]), 'OTHER')).toBeUndefined();
    const impostor = { get: () => rule } as unknown as ReadonlyMap<string, AdmittedRuleV2>;
    expect(admittedRuleV2(impostor, 'N8N_CODE_NODE')).toBeUndefined();
    expect(admittedRuleV2(Object.freeze(Object.assign(Object.create(null), { get: 'not a function' })) as unknown as ReadonlyMap<string, AdmittedRuleV2>, 'N8N_CODE_NODE')).toBeUndefined();
  });

  it('lets a claim repeat the admitted identity but never override a field of it', () => {
    const full: Record<string, string> = {};
    for (const field of RULE_AUTHORITY_FIELDS_V2) full[field] = rule[field];
    expect(ruleAuthorityMatchesV2(rule, full)).toBe(true);
    expect(ruleAuthorityMatchesV2(rule, {})).toBe(true);
    for (const field of RULE_AUTHORITY_FIELDS_V2) {
      const overridden = { ...full, [field]: field === 'severity' ? 'INFO' : 'REASSIGNED' };
      if (overridden[field] === rule[field]) continue;
      expect(ruleAuthorityMatchesV2(rule, overridden)).toBe(false);
    }
  });
});
