import { describe, expect, it } from 'vitest';
import {
  ADMITTED_PROFILE_MANIFESTS_V2,
  BETA_DEFAULT_PROFILE_MANIFEST,
  BETA_HARDENED_PROFILE_MANIFEST,
  PROFILE_MANIFEST_REGISTRY_V2,
  computeProfileManifestDigest,
  isProfileAdmitted,
  validateProfileManifest,
  type ProfileManifestV2,
} from './profile-manifest';
import type { ProfileCapabilityV2, ProfileRegistryEntryV2 } from './profile-manifest';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import type { CapabilityCandidateV2 } from './scheduler';

/**
 * Conformance transcription of `openspec/changes/world-class-scanner-cli/core-registry-contracts.md`
 * ("Profiles and initial capability order"). The contract is the authority: every list below is
 * copied from its prose, and the manifest must equal it exactly - capability set, requiredness,
 * dependency edges, declaration order, and rule ownership.
 */

/** The 17 initial rule IDs, in `v1-projection-ledger.md` order. */
const LEDGER_RULE_IDS = [
  'N8N_EXECUTE_COMMAND', 'N8N_CODE_NODE', 'RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR', 'UNAPPROVED_DOMAIN',
  'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE', 'JAVASCRIPT_DYNAMIC_EXECUTION', 'PYTHON_DYNAMIC_EXECUTION',
  'TAINTED_COMMAND', 'TAINTED_SQL_QUERY', 'TAINTED_REQUEST_URL', 'TAINTED_FILE_PATH', 'TAINTED_CODE_INPUT',
  'TAINTED_REQUEST_HEADER', 'TAINTED_AI_PROMPT', 'AI_AGENT_UNGATED_TOOL',
] as const;

type DeclaredCapability = Readonly<{ id: string; required: boolean; dependsOn: readonly string[] }>;

/** `beta-default@2.0.0` order, requiredness, and dependencies. */
const CONTRACT_DEFAULT: readonly DeclaredCapability[] = [
  { id: 'source-normalization', required: true, dependsOn: [] },
  { id: 'workflow-insights', required: true, dependsOn: ['source-normalization'] },
  { id: 'structural-policies', required: true, dependsOn: ['source-normalization'] },
  { id: 'assessment', required: true, dependsOn: ['workflow-insights', 'structural-policies'] },
  { id: 'presentation-facts', required: true, dependsOn: ['assessment'] },
];

/** `beta-hardened@2.0.0` retains that order and inserts the optional report-only set after structural policies. */
const CONTRACT_HARDENED: readonly DeclaredCapability[] = [
  CONTRACT_DEFAULT[0]!, CONTRACT_DEFAULT[1]!, CONTRACT_DEFAULT[2]!,
  { id: 'expression-security', required: false, dependsOn: ['source-normalization'] },
  { id: 'javascript-security', required: false, dependsOn: ['source-normalization'] },
  { id: 'python-security', required: false, dependsOn: ['source-normalization'] },
  { id: 'graph-semantics', required: false, dependsOn: ['source-normalization'] },
  { id: 'taint-confidentiality', required: false, dependsOn: ['graph-semantics', 'expression-security', 'javascript-security', 'python-security'] },
  { id: 'taint-integrity', required: false, dependsOn: ['graph-semantics', 'expression-security', 'javascript-security', 'python-security'] },
  { id: 'agentic-control', required: false, dependsOn: ['graph-semantics', 'taint-confidentiality', 'taint-integrity'] },
  CONTRACT_DEFAULT[3]!, CONTRACT_DEFAULT[4]!,
];

/** Exact initial ownership; expression, graph, and confidentiality capabilities own no rule. */
const CONTRACT_RULE_OWNER: Readonly<Record<string, string>> = {
  N8N_EXECUTE_COMMAND: 'structural-policies', N8N_CODE_NODE: 'structural-policies',
  RAW_AUTH_HEADER: 'structural-policies', RAW_SECRET_INDICATOR: 'structural-policies',
  UNAPPROVED_DOMAIN: 'structural-policies', UNKNOWN_NODE_PACKAGE: 'structural-policies',
  WEBHOOK_EXPOSURE: 'structural-policies', JAVASCRIPT_DYNAMIC_EXECUTION: 'javascript-security',
  PYTHON_DYNAMIC_EXECUTION: 'python-security', TAINTED_COMMAND: 'taint-integrity',
  TAINTED_SQL_QUERY: 'taint-integrity', TAINTED_REQUEST_URL: 'taint-integrity',
  TAINTED_FILE_PATH: 'taint-integrity', TAINTED_CODE_INPUT: 'taint-integrity',
  TAINTED_REQUEST_HEADER: 'taint-integrity', TAINTED_AI_PROMPT: 'taint-integrity',
  AI_AGENT_UNGATED_TOOL: 'agentic-control',
};

const emptyCandidate = (): CapabilityCandidateV2 => ({
  findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0,
});

function registryFor(manifest: ProfileManifestV2): Map<string, ProfileRegistryEntryV2> {
  const entries = manifest.capabilities.map((capability) => [capability.id, { ...capability, run: emptyCandidate }] as const);
  return new Map(entries);
}

/** Re-declare a capability list, recomputing the digest so only the declaration under test can fail. */
function declare(manifest: ProfileManifestV2, capabilities: readonly ProfileCapabilityV2[]): ProfileManifestV2 {
  const { digest: _digest, ...body } = { ...manifest, capabilities };
  return { ...body, digest: computeProfileManifestDigest(body) };
}

function declarationOf(manifest: ProfileManifestV2): readonly DeclaredCapability[] {
  return manifest.capabilities.map(({ id, required, dependsOn }) => ({ id, required, dependsOn: [...dependsOn] }));
}

function bodyOf(manifest: ProfileManifestV2): Omit<ProfileManifestV2, 'digest'> {
  const { digest: _digest, ...body } = manifest;
  return body;
}

function rulesOwnedBy(capabilities: readonly ProfileCapabilityV2[]): Readonly<Record<string, string>> {
  const owners: Record<string, string> = {};
  for (const capability of capabilities) for (const ruleId of capability.ruleIds) owners[ruleId] = capability.id;
  return owners;
}

describe('profile-registry contract conformance', () => {
  it('declares the contract capability set, requiredness, dependency edges, and order exactly', () => {
    expect(declarationOf(BETA_DEFAULT_PROFILE_MANIFEST)).toEqual(CONTRACT_DEFAULT);
    expect(declarationOf(BETA_HARDENED_PROFILE_MANIFEST)).toEqual(CONTRACT_HARDENED);
    for (const capability of [...BETA_DEFAULT_PROFILE_MANIFEST.capabilities, ...BETA_HARDENED_PROFILE_MANIFEST.capabilities]) {
      expect(capability.version).toBe('2.0.0');
    }
    expect(BETA_DEFAULT_PROFILE_MANIFEST.version).toBe('2.0.0');
    expect(BETA_HARDENED_PROFILE_MANIFEST.version).toBe('2.0.0');
    expect(BETA_DEFAULT_PROFILE_MANIFEST.schemaVersion).toBe('scanner-profile-v2');
  });

  it('owns exactly the contract rule set, once per profile, from the single rule authority', () => {
    for (const profile of PROFILE_MANIFEST_REGISTRY_V2) {
      const declared = new Set(profile.capabilities.map(({ id }) => id));
      expect(rulesOwnedBy(profile.capabilities)).toEqual(Object.fromEntries(Object.entries(CONTRACT_RULE_OWNER).filter(([, owner]) => declared.has(owner))));
      for (const capability of profile.capabilities) {
        const authority = SAFE_FACT_EVIDENCE_MAPPINGS_V2.filter(({ ownerCapabilityId }) => ownerCapabilityId === capability.id).map(({ ruleId }) => ruleId);
        expect(capability.ruleIds).toEqual(authority);
      }
    }
    expect(new Set(Object.keys(CONTRACT_RULE_OWNER))).toEqual(new Set(LEDGER_RULE_IDS));
    expect(Object.keys(CONTRACT_RULE_OWNER)).toHaveLength(LEDGER_RULE_IDS.length);
    for (const ruleId of LEDGER_RULE_IDS) expect(CONTRACT_RULE_OWNER[ruleId]).toBeDefined();
  });

  it('orders capabilities by declaration and accepts only a topological declaration', () => {
    for (const profile of PROFILE_MANIFEST_REGISTRY_V2) {
      const index = new Map(profile.capabilities.map((capability, position) => [capability.id, position]));
      for (const capability of profile.capabilities) {
        for (const dependency of capability.dependsOn) {
          expect(index.has(dependency)).toBe(true);
          expect(index.get(dependency)!).toBeLessThan(index.get(capability.id)!);
        }
      }
    }
    const reversed = declare(BETA_DEFAULT_PROFILE_MANIFEST, [...BETA_DEFAULT_PROFILE_MANIFEST.capabilities].reverse());
    expect(validateProfileManifest(reversed, registryFor(reversed))).toMatchObject({ ok: false, code: 'PROFILE_MANIFEST_INVALID' });
  });

  it('rejects missing, duplicate, unknown, forward, and cyclic ownership before scanning', () => {
    const registry = registryFor(BETA_HARDENED_PROFILE_MANIFEST);
    const structural = BETA_HARDENED_PROFILE_MANIFEST.capabilities[2]!;
    const javascript = BETA_HARDENED_PROFILE_MANIFEST.capabilities[4]!;
    const redeclare = (id: string, change: (capability: ProfileCapabilityV2) => ProfileCapabilityV2): ProfileManifestV2 =>
      declare(BETA_HARDENED_PROFILE_MANIFEST, BETA_HARDENED_PROFILE_MANIFEST.capabilities.map((capability) => (capability.id === id ? change(capability) : capability)));
    const cases: readonly (readonly [ProfileManifestV2, string])[] = [
      [redeclare(structural.id, (capability) => ({ ...capability, ruleIds: capability.ruleIds.slice(0, -1) })), 'MISSING_RULE_OWNER'],
      [redeclare(javascript.id, (capability) => ({ ...capability, ruleIds: [] })), 'MISSING_RULE_OWNER'],
      [redeclare(structural.id, (capability) => ({ ...capability, ruleIds: [...capability.ruleIds, ...javascript.ruleIds] })), 'DUPLICATE_RULE_OWNER'],
      [redeclare(javascript.id, (capability) => ({ ...capability, ruleIds: ['NOT_A_RULE'] })), 'UNKNOWN_RULE'],
      [redeclare('workflow-insights', (capability) => ({ ...capability, dependsOn: ['not-a-capability'] })), 'MISSING_DEPENDENCY'],
      [redeclare('expression-security', (capability) => ({ ...capability, dependsOn: ['python-security'] })), 'FORWARD_DEPENDENCY'],
      [redeclare('source-normalization', (capability) => ({ ...capability, dependsOn: ['workflow-insights'] })), 'DEPENDENCY_CYCLE'],
      [{ ...BETA_HARDENED_PROFILE_MANIFEST, digest: '0'.repeat(64) }, 'MANIFEST_DIGEST_MISMATCH'],
    ];
    for (const [candidate, reason] of cases) {
      expect(validateProfileManifest(candidate, registry)).toEqual({ ok: false, code: 'PROFILE_MANIFEST_INVALID', reason });
    }
  });

  it('refuses a re-declared owned field even when the digest is recomputed', () => {
    const registry = registryFor(BETA_DEFAULT_PROFILE_MANIFEST);
    const flipped = declare(BETA_DEFAULT_PROFILE_MANIFEST, BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => (capability.id === 'assessment' ? { ...capability, required: false } : capability)));
    const addedRule = declare(BETA_DEFAULT_PROFILE_MANIFEST, BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => (capability.id === 'presentation-facts' ? { ...capability, ruleIds: ['N8N_EXECUTE_COMMAND'] } : capability)));
    expect(flipped.digest).not.toBe(BETA_DEFAULT_PROFILE_MANIFEST.digest);
    expect(addedRule.digest).not.toBe(BETA_DEFAULT_PROFILE_MANIFEST.digest);
    expect(validateProfileManifest(flipped, registry)).toMatchObject({ ok: false, reason: 'UNKNOWN_CAPABILITY' });
    expect(validateProfileManifest(addedRule, registry)).toMatchObject({ ok: false, reason: 'DUPLICATE_RULE_OWNER' });
  });

  it('keeps the manifest digest a pure function of the declaration', () => {
    expect(computeProfileManifestDigest(bodyOf(BETA_DEFAULT_PROFILE_MANIFEST))).toBe(BETA_DEFAULT_PROFILE_MANIFEST.digest);
    expect(computeProfileManifestDigest(bodyOf(BETA_DEFAULT_PROFILE_MANIFEST))).toBe(computeProfileManifestDigest(bodyOf(BETA_DEFAULT_PROFILE_MANIFEST)));
    expect(computeProfileManifestDigest(bodyOf(BETA_HARDENED_PROFILE_MANIFEST))).toBe(BETA_HARDENED_PROFILE_MANIFEST.digest);
  });

  it('moves the digest for every owned field', () => {
    const base = BETA_DEFAULT_PROFILE_MANIFEST;
    const digests = {
      id: computeProfileManifestDigest({ ...bodyOf(base), id: 'beta-other' }),
      version: computeProfileManifestDigest({ ...bodyOf(base), version: '2.0.1' }),
      scoringPolicyVersion: computeProfileManifestDigest({ ...bodyOf(base), scoringPolicyVersion: 'other-policy' }),
      capabilityId: computeProfileManifestDigest(bodyOf(declare(base, base.capabilities.map((capability, position) => (position === 0 ? { ...capability, id: 'renamed-source' } : capability))))),
      capabilityVersion: computeProfileManifestDigest(bodyOf(declare(base, base.capabilities.map((capability, position) => (position === 0 ? { ...capability, version: '3.0.0' } : capability))))),
      required: computeProfileManifestDigest(bodyOf(declare(base, base.capabilities.map((capability, position) => (position === 0 ? { ...capability, required: false } : capability))))),
      dependsOn: computeProfileManifestDigest(bodyOf(declare(base, base.capabilities.map((capability, position) => (position === 1 ? { ...capability, dependsOn: [] } : capability))))),
      ruleIds: computeProfileManifestDigest(bodyOf(declare(base, base.capabilities.map((capability, position) => (position === 2 ? { ...capability, ruleIds: capability.ruleIds.slice(0, -1) } : capability))))),
      capabilityOrder: computeProfileManifestDigest(bodyOf(declare(base, [...base.capabilities].reverse()))),
    };
    for (const [field, digest] of Object.entries(digests)) {
      expect(digest, field).toMatch(/^[a-f0-9]{64}$/);
      expect(digest, field).not.toBe(base.digest);
      expect(new Set(Object.values(digests)).size, field).toBe(Object.keys(digests).length);
    }
  });

  it('keeps beta-hardened defined but unadmitted and beta-default the only admitted profile', () => {
    expect(ADMITTED_PROFILE_MANIFESTS_V2).toEqual([BETA_DEFAULT_PROFILE_MANIFEST]);
    expect(isProfileAdmitted(BETA_DEFAULT_PROFILE_MANIFEST)).toBe(true);
    expect(isProfileAdmitted(BETA_HARDENED_PROFILE_MANIFEST)).toBe(false);
    expect(validateProfileManifest(BETA_HARDENED_PROFILE_MANIFEST, registryFor(BETA_HARDENED_PROFILE_MANIFEST)))
      .toEqual({ ok: false, code: 'PROFILE_MANIFEST_NOT_ADMITTED', reason: 'PROFILE_NOT_ADMITTED' });
  });
});
