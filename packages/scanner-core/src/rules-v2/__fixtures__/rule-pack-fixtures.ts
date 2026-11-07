import { createAdmittedRuleView } from '../../v2/admitted-registry';

/**
 * Pack fixtures derive their rule identity from the admitted catalogue instead of inventing one.
 *
 * A rule body may only repeat an admitted identity, so a fixture that hard-coded its own rule id
 * or remediation would be rejected — and a rejection test written against it would pass for the
 * wrong reason. These constants follow the catalogue, so the positive fixtures keep proving that a
 * body matching the authority is admitted and the negative ones prove exactly one disagreement.
 */
const admitted = createAdmittedRuleView().rules.get('UNAPPROVED_DOMAIN');
if (admitted === undefined) throw new TypeError('Fixture rule authority is incomplete');

export const ADMITTED_PACK_RULE = Object.freeze({
  ruleId: admitted.ruleId,
  revision: '1',
  capabilityId: admitted.capabilityId,
  evidenceSchemaId: admitted.evidenceSchemaId,
  remediationId: admitted.remediationId,
});

/** A rule id the admitted catalogue does not carry: no body can give it an identity. */
export const UNKNOWN_PACK_RULE = Object.freeze({ ...ADMITTED_PACK_RULE, ruleId: 'NOT_AN_ADMITTED_RULE' });

/** A body that claims an admitted id but reassigns ownership away from the catalogue's owner. */
export const FOREIGN_OWNER_PACK_RULE = Object.freeze({ ...ADMITTED_PACK_RULE, capabilityId: 'javascript-security' });

/** A body that keeps the admitted owner but rewrites the evidence schema it would project. */
export const FOREIGN_EVIDENCE_PACK_RULE = Object.freeze({ ...ADMITTED_PACK_RULE, evidenceSchemaId: 'v1.taint' });

/** A body that keeps the admitted identity but points remediation somewhere else. */
export const FOREIGN_REMEDIATION_PACK_RULE = Object.freeze({ ...ADMITTED_PACK_RULE, remediationId: 'invented-remediation' });
