import { describe, expect, it, vi } from 'vitest';
import {
  BETA_DEFAULT_PROFILE_MANIFEST,
  BETA_HARDENED_PROFILE_MANIFEST,
  computeProfileManifestDigest,
  isProfileAdmitted,
  validateProfileManifest,
  type ProfileManifestV2,
} from './profile-manifest';
import type { ProfileRegistryEntryV2 } from './profile-manifest';
import type { CapabilityCandidateV2 } from './scheduler';

const emptyCandidate = (): CapabilityCandidateV2 => ({
  findings: [], diagnostics: [], facts: [], traces: [], seen: 0, analyzed: 0, skipped: 0, omitted: 0,
});

function registryFor(manifest: ProfileManifestV2): Map<string, ProfileRegistryEntryV2> {
  return new Map(manifest.capabilities.map((capability) => [capability.id, {
    ...capability,
    run: () => emptyCandidate(),
  }]));
}

function copyManifest(manifest: ProfileManifestV2, capabilities = manifest.capabilities): ProfileManifestV2 {
  return { ...manifest, capabilities: capabilities.map((capability) => ({ ...capability })) };
}

describe('profile manifests', () => {
  it('defines exact frozen manifests and admits only beta-default', () => {
    const defaultResult = validateProfileManifest(BETA_DEFAULT_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST));
    const hardenedResult = validateProfileManifest(BETA_HARDENED_PROFILE_MANIFEST, registryFor(BETA_HARDENED_PROFILE_MANIFEST));

    expect(defaultResult).toMatchObject({ ok: true, manifest: BETA_DEFAULT_PROFILE_MANIFEST });
    expect(Object.isFrozen(defaultResult)).toBe(true);
    expect(hardenedResult).toMatchObject({ ok: false, code: 'PROFILE_MANIFEST_NOT_ADMITTED', reason: 'PROFILE_NOT_ADMITTED' });
    expect(validateProfileManifest(BETA_HARDENED_PROFILE_MANIFEST, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false, code: 'PROFILE_MANIFEST_NOT_ADMITTED', reason: 'PROFILE_NOT_ADMITTED' });
    expect(isProfileAdmitted(BETA_DEFAULT_PROFILE_MANIFEST)).toBe(true);
    expect(isProfileAdmitted(BETA_HARDENED_PROFILE_MANIFEST)).toBe(false);
    expect(Object.isFrozen(BETA_DEFAULT_PROFILE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(BETA_DEFAULT_PROFILE_MANIFEST.capabilities[0])).toBe(true);
    expect(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id }) => id)).toEqual([
      'source-normalization', 'workflow-insights', 'structural-policies', 'assessment', 'presentation-facts',
    ]);
    expect(BETA_HARDENED_PROFILE_MANIFEST.capabilities.map(({ id }) => id)).toEqual([
      'source-normalization', 'workflow-insights', 'structural-policies', 'expression-security', 'javascript-security',
      'python-security', 'graph-semantics', 'taint-confidentiality', 'taint-integrity', 'agentic-control',
      'assessment', 'presentation-facts',
    ]);
    const expectedOwnership = {
      N8N_EXECUTE_COMMAND: 'structural-policies', N8N_CODE_NODE: 'structural-policies',
      RAW_AUTH_HEADER: 'structural-policies', RAW_SECRET_INDICATOR: 'structural-policies',
      UNAPPROVED_DOMAIN: 'structural-policies', UNKNOWN_NODE_PACKAGE: 'structural-policies',
      WEBHOOK_EXPOSURE: 'structural-policies', JAVASCRIPT_DYNAMIC_EXECUTION: 'javascript-security',
      PYTHON_DYNAMIC_EXECUTION: 'python-security', TAINTED_COMMAND: 'taint-integrity',
      TAINTED_SQL_QUERY: 'taint-integrity', TAINTED_REQUEST_URL: 'taint-integrity',
      TAINTED_FILE_PATH: 'taint-integrity', TAINTED_CODE_INPUT: 'taint-integrity',
      TAINTED_REQUEST_HEADER: 'taint-integrity', TAINTED_AI_PROMPT: 'taint-integrity',
      AI_AGENT_UNGATED_TOOL: 'agentic-control',
    } as const;
    const actualOwnership = new Map(BETA_HARDENED_PROFILE_MANIFEST.capabilities.flatMap(({ id, ruleIds }) => ruleIds.map((ruleId) => [ruleId, id] as const)));
    expect(actualOwnership).toEqual(new Map(Object.entries(expectedOwnership)));
    expect(actualOwnership.size).toBe(17);
  });
  it('defines the exact capability order, requiredness, and dependency frontier', () => {
    expect(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map(({ id, required, dependsOn, ruleIds }) => [id, required, dependsOn, ruleIds])).toEqual([
      ['source-normalization', true, [], []],
      ['workflow-insights', true, ['source-normalization'], []],
      ['structural-policies', true, ['source-normalization'], [
        'N8N_EXECUTE_COMMAND', 'N8N_CODE_NODE', 'RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR',
        'UNAPPROVED_DOMAIN', 'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE',
      ]],
      ['assessment', true, ['workflow-insights', 'structural-policies'], []],
      ['presentation-facts', true, ['assessment'], []],
    ]);
    expect(BETA_HARDENED_PROFILE_MANIFEST.capabilities.slice(3, 10).map(({ id, dependsOn }) => [id, dependsOn])).toEqual([
      ['expression-security', ['source-normalization']],
      ['javascript-security', ['source-normalization']],
      ['python-security', ['source-normalization']],
      ['graph-semantics', ['source-normalization']],
      ['taint-confidentiality', ['graph-semantics', 'expression-security', 'javascript-security', 'python-security']],
      ['taint-integrity', ['graph-semantics', 'expression-security', 'javascript-security', 'python-security']],
      ['agentic-control', ['graph-semantics', 'taint-confidentiality', 'taint-integrity']],
    ]);
  });

  it('rejects ownership, dependency, duplicate, and digest violations before admission', () => {
    const base = BETA_HARDENED_PROFILE_MANIFEST;
    const structural = base.capabilities.find(({ id }) => id === 'structural-policies')!;
    const javascript = base.capabilities.find(({ id }) => id === 'javascript-security')!;
    const duplicateOwner = copyManifest(base, base.capabilities.map((capability) => capability.id === structural.id
      ? { ...capability, ruleIds: [...capability.ruleIds, ...javascript.ruleIds] } : capability));
    const unknownRule = copyManifest(base, base.capabilities.map((capability) => capability.id === javascript.id
      ? { ...capability, ruleIds: ['NOT_A_RULE'] } : capability));
    const missingDependency = copyManifest(base, base.capabilities.map((capability) => capability.id === 'workflow-insights'
      ? { ...capability, dependsOn: ['not-in-manifest'] } : capability));
    const cycle = copyManifest(base, base.capabilities.map((capability) => capability.id === 'source-normalization'
      ? { ...capability, dependsOn: ['workflow-insights'] } : capability));
    const duplicateCapability = copyManifest(base, [...base.capabilities, { ...structural }]);
    const missingCapability = copyManifest(base, base.capabilities.slice(0, -1));
    const unknownCapability = copyManifest(base, [...base.capabilities, {
      id: 'unknown', version: '2.0.0', required: false, dependsOn: [], ruleIds: [],
    }]);
    const invalidCases: Array<[ProfileManifestV2, string]> = [
      [duplicateOwner, 'DUPLICATE_RULE_OWNER'],
      [unknownRule, 'UNKNOWN_RULE'],
      [missingDependency, 'MISSING_DEPENDENCY'],
      [cycle, 'DEPENDENCY_CYCLE'],
      [duplicateCapability, 'DUPLICATE_CAPABILITY'],
      [missingCapability, 'UNKNOWN_CAPABILITY'],
      [unknownCapability, 'UNKNOWN_CAPABILITY'],
      [{ ...base, digest: '0'.repeat(64) }, 'MANIFEST_DIGEST_MISMATCH'],
    ];

    for (const [candidate, reason] of invalidCases) {
      const result = validateProfileManifest(candidate, registryFor(base));
      expect(result).toMatchObject({ ok: false, code: 'PROFILE_MANIFEST_INVALID', reason });
    }
  });

  it('rejects a known manifest with a missing expected rule owner before registry lookup', () => {
    // A registry-owned rule with no owner in the manifest is the contract's distinct "missing
    // ownership" cause (`core-registry-contracts.md`), not an unknown capability or profile.
    const { digest: _digest, ...body } = {
      ...BETA_HARDENED_PROFILE_MANIFEST,
      capabilities: BETA_HARDENED_PROFILE_MANIFEST.capabilities.map((capability) => capability.id === 'structural-policies'
        ? { ...capability, ruleIds: capability.ruleIds.slice(0, -1) }
        : { ...capability }),
    };
    const candidate = { ...body, digest: computeProfileManifestDigest(body) };
    const registry = registryFor(BETA_HARDENED_PROFILE_MANIFEST);
    let executed = false;
    for (const [id, entry] of registry) registry.set(id, { ...entry, run: () => { executed = true; return emptyCandidate(); } });
    let registryLookups = 0;
    const originalGet = Map.prototype.get;
    const lookupSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (this === registry) registryLookups += 1;
      return originalGet.call(this, key);
    });
    try {
      expect(validateProfileManifest(candidate, registry)).toEqual({ ok: false, code: 'PROFILE_MANIFEST_INVALID', reason: 'MISSING_RULE_OWNER' });
      expect(registryLookups).toBe(0);
      expect(executed).toBe(false);
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('rejects a forward dependency before admission', () => {
    const base = BETA_HARDENED_PROFILE_MANIFEST;
    const candidate = copyManifest(base, base.capabilities.map((capability) => capability.id === 'expression-security'
      ? { ...capability, dependsOn: ['python-security'] }
      : capability));

    expect(validateProfileManifest(candidate, registryFor(base))).toMatchObject({
      ok: false, code: 'PROFILE_MANIFEST_INVALID', reason: 'FORWARD_DEPENDENCY',
    });
  });

  it('rejects prototype-bearing and accessor manifests without invoking the accessor', () => {
    let invoked = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'schemaVersion', { get: () => { invoked = true; return 'scanner-profile-v2'; } });
    expect(validateProfileManifest(accessor, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
    expect(invoked).toBe(false);
    expect(validateProfileManifest(Object.create({}), registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
  });

  it('keeps admission closed to mutable clones and hidden keys', () => {
    const mutableClone = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST);
    expect(isProfileAdmitted(mutableClone)).toBe(false);
    const hiddenKey = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST) as Record<string, unknown>;
    Object.defineProperty(hiddenKey, 'hidden', { value: 'secret', enumerable: false });
    expect(isProfileAdmitted(hiddenKey)).toBe(false);
    const accessor = Object.create(null) as Record<string, unknown>;
    let invoked = false;
    for (const key of ['schemaVersion', 'id', 'version', 'capabilities', 'scoringPolicyVersion', 'digest']) {
      Object.defineProperty(accessor, key, { get: () => { invoked = true; return BETA_DEFAULT_PROFILE_MANIFEST[key as keyof ProfileManifestV2]; } });
    }
    expect(isProfileAdmitted(accessor)).toBe(false);
    expect(invoked).toBe(false);
  });

  it('preflights hostile manifest shapes and never executes registry runners', () => {
    let invoked = false;
    const registry = new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, {
      ...capability,
      run: () => { invoked = true; return emptyCandidate(); },
    }]));
    const sparse = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST, (() => {
      const values = new Array(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.length);
      values[0] = BETA_DEFAULT_PROFILE_MANIFEST.capabilities[0];
      return values as unknown as ProfileManifestV2['capabilities'];
    })());
    const cyclic = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST, (() => {
      const values: unknown[] = [];
      values.push(values);
      return values as ProfileManifestV2['capabilities'];
    })());
    const symbolKey = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST) as Record<string | symbol, unknown>;
    symbolKey[Symbol('unexpected')] = true;
    expect(validateProfileManifest(sparse, registry)).toMatchObject({ ok: false });
    expect(validateProfileManifest(cyclic, registry)).toMatchObject({ ok: false });
    expect(validateProfileManifest(symbolKey, registry)).toMatchObject({ ok: false });
    expect(validateProfileManifest(BETA_DEFAULT_PROFILE_MANIFEST, registry)).toMatchObject({ ok: true });
    expect(invoked).toBe(false);
  });

  it('rejects a proxied registry contract without invoking a runner', () => {
    let invoked = false;
    const registry = new Proxy(new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, {
      ...capability,
      run: () => { invoked = true; return emptyCandidate(); },
    }])), { get: (target, property, receiver) => Reflect.get(target, property, receiver) });

    expect(validateProfileManifest(BETA_DEFAULT_PROFILE_MANIFEST, registry)).toMatchObject({ ok: false });
    expect(invoked).toBe(false);
  });

  it('rejects cap-plus-one own-key and symbol collections in manifests', () => {
    const oversizedCapabilities = new Array(33) as unknown as ProfileManifestV2['capabilities'];
    const extraKeyCapabilities = BETA_DEFAULT_PROFILE_MANIFEST.capabilities.slice();
    Object.defineProperty(extraKeyCapabilities, 'overflow', { value: true });
    const extraSymbolCapabilities = BETA_DEFAULT_PROFILE_MANIFEST.capabilities.slice();
    Object.defineProperty(extraSymbolCapabilities, Symbol('overflow'), { value: true });
    const oversizedDependency = copyManifest(BETA_DEFAULT_PROFILE_MANIFEST, BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability, index) => index === 0
      ? { ...capability, dependsOn: new Array(18).fill('source-normalization') } : capability));
    expect(validateProfileManifest({ ...BETA_DEFAULT_PROFILE_MANIFEST, capabilities: oversizedCapabilities }, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
    expect(validateProfileManifest({ ...BETA_DEFAULT_PROFILE_MANIFEST, capabilities: extraKeyCapabilities }, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
    expect(validateProfileManifest({ ...BETA_DEFAULT_PROFILE_MANIFEST, capabilities: extraSymbolCapabilities }, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
    expect(validateProfileManifest(oversizedDependency, registryFor(BETA_DEFAULT_PROFILE_MANIFEST))).toMatchObject({ ok: false });
  });

  it('keeps digest and validation independent of registry insertion order', () => {
    const entries = [...registryFor(BETA_DEFAULT_PROFILE_MANIFEST).entries()];
    const reversed = new Map(entries.reverse());
    const first = validateProfileManifest(BETA_DEFAULT_PROFILE_MANIFEST, new Map(entries));
    const second = validateProfileManifest(BETA_DEFAULT_PROFILE_MANIFEST, reversed);
    expect(BETA_DEFAULT_PROFILE_MANIFEST.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    expect([...reversed.keys()]).toEqual(entries.map(([id]) => id));
  });
});
