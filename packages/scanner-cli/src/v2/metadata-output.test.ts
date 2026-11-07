import { describe, expect, it } from 'vitest';
import {
  emitConfigValidationDocumentV2,
  emitExplainDocumentV2,
  emitMetadataCommandResultV2,
  emitProfilesDocumentV2,
  emitRulesDocumentV2,
  emitVersionDocumentV2,
  renderMetadataTableV2,
  serializeMetadataJsonV2,
  serializeMetadataV2,
} from './metadata-output';
import { rulesDocumentV2 } from './commands';

describe('metadata-output', () => {
  it('emits deterministic rules document as json and table', () => {
    const json1 = emitRulesDocumentV2('json');
    const json2 = emitRulesDocumentV2('json');
    expect(json1).toBe(json2);
    const parsed = JSON.parse(json1);
    expect(parsed.schemaVersion).toBe('n8n-scan-rules-v2');
    expect(parsed.tool.name).toBe('n8n-scan');
    expect(parsed.rules.map((r: { ruleId: string }) => r.ruleId)).toEqual([
      'N8N_EXECUTE_COMMAND', 'N8N_CODE_NODE', 'RAW_AUTH_HEADER', 'RAW_SECRET_INDICATOR',
      'UNAPPROVED_DOMAIN', 'UNKNOWN_NODE_PACKAGE', 'WEBHOOK_EXPOSURE',
    ]);
    const table = emitRulesDocumentV2('table');
    expect(table).toContain('Rule ID');
    expect(table).toContain('N8N_EXECUTE_COMMAND');
  });

  it('emits explain document for admitted rules and rejects unknown rules', () => {
    const res = emitExplainDocumentV2('N8N_EXECUTE_COMMAND', 'json');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.output);
      expect(parsed.schemaVersion).toBe('n8n-scan-explain-v2');
      expect(parsed.rule.ruleId).toBe('N8N_EXECUTE_COMMAND');
      expect(parsed.prose.title).toContain('Execute Command');
    }
    const tableRes = emitExplainDocumentV2('N8N_EXECUTE_COMMAND', 'table');
    expect(tableRes.ok).toBe(true);
    if (tableRes.ok) expect(tableRes.output).toContain('Rule: N8N_EXECUTE_COMMAND');
    expect(emitExplainDocumentV2('NOT_A_REAL_RULE').ok).toBe(false);
  });

  it('emits profiles, version, and validation documents with exact authority', () => {
    const pJson = JSON.parse(emitProfilesDocumentV2('json'));
    expect(pJson.schemaVersion).toBe('n8n-scan-profiles-v2');
    expect(pJson.profiles[0].id).toBe('beta-default');
    expect(pJson.profiles[0].admitted).toBe(true);
    expect(pJson.profiles[0].advertised).toBe(true);
    expect(pJson.profiles[1].id).toBe('beta-hardened');
    expect(pJson.profiles[1].admitted).toBe(false);
    expect(pJson.profiles[1].advertised).toBe(true);
    const hardenedCaps = pJson.profiles[1].capabilities.map((c: { id: string }) => c.id);
    expect(new Set(hardenedCaps).size).toBe(hardenedCaps.length); // No duplicate capability IDs!

    const vJson = JSON.parse(emitVersionDocumentV2('json'));
    expect(vJson.schemaVersion).toBe('n8n-scan-version-v2');
    expect(vJson.name).toBe('n8n-scan');
    expect(emitVersionDocumentV2('table')).toContain('Engine: secureflow-scanner');

    const valid = emitConfigValidationDocumentV2({ schemaVersion: 'n8n-scan-config-v2' }, 'json');
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(JSON.parse(valid.output).schemaVersion).toBe('n8n-scan-config-validation-v2');
    expect(emitConfigValidationDocumentV2({ schemaVersion: 'bad' }).ok).toBe(false);
  });

  it('handles command results and passes configDirectory to validate-config', () => {
    const rulesRes = emitMetadataCommandResultV2({ kind: 'rules', schema: 'v2', format: 'json' });
    expect(rulesRes.ok).toBe(true);
    if (rulesRes.ok) expect(JSON.parse(rulesRes.output).schemaVersion).toBe('n8n-scan-rules-v2');

    const validConfigRes = emitMetadataCommandResultV2(
      { kind: 'validate-config', schema: 'v2', format: 'json', path: 'test-config.json' },
      JSON.stringify({ schemaVersion: 'n8n-scan-config-v2' }),
      { configDirectory: '.' },
    );
    expect(validConfigRes.ok).toBe(true);

    const scanCmd = {
      kind: 'scan' as const, schema: 'v2' as const, inputs: ['wf.json'], format: 'json' as const, profile: 'beta-default' as const,
      failOn: 'INFO' as const, requireComplete: false, concurrency: 1, auditSupplyChain: false, includeReadiness: false, rules: 'builtin' as const, catalogue: 'builtin' as const,
      limits: 'builtin', edition: 'UNKNOWN' as const, deployment: 'UNKNOWN' as const, role: 'UNKNOWN' as const, taskRunner: 'UNKNOWN' as const,
      communityPackages: [], configuration: [], approvedDomains: [], include: [], exclude: [], allowUnsignedDevelopmentRules: false, noColor: false, cliOverrides: {},
    };
    expect(emitMetadataCommandResultV2(scanCmd).ok).toBe(false);
  });

  it('rejects bogus schema IDs, extra/private fields, non-canonical key order, accessors, and symbols', () => {
    expect(() => serializeMetadataJsonV2(null as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);
    expect(() => serializeMetadataJsonV2({ schemaVersion: 'bogus' } as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    const normal = rulesDocumentV2();
    expect(() => serializeMetadataJsonV2({ ...normal, _private: 'secret' } as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);
    expect(() => serializeMetadataJsonV2({ ...normal, artifacts: { ...normal.artifacts, extra: 1 } } as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    // Object with symbol property
    const withSymbol = { ...normal, [Symbol('bad')]: true };
    expect(() => serializeMetadataJsonV2(withSymbol as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    // Object with getter
    const withGetter = { ...normal };
    Object.defineProperty(withGetter, 'hacked', { get: () => 'leak', enumerable: true });
    expect(() => serializeMetadataJsonV2(withGetter as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    // Sparse array (null hole)
    const sparseRules = new Array(7);
    sparseRules[0] = normal.rules[0];
    expect(() => serializeMetadataJsonV2({ ...normal, rules: sparseRules } as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    // Non-canonical key order: place 'rules' before 'schemaVersion'
    const nonCanonical = { rules: normal.rules, schemaVersion: normal.schemaVersion, tool: normal.tool, artifacts: normal.artifacts };
    expect(() => serializeMetadataJsonV2(nonCanonical as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);

    expect(() => serializeMetadataV2(normal, 'xml' as unknown as 'json')).toThrow(TypeError);
    expect(() => renderMetadataTableV2({ schemaVersion: 'bogus' } as unknown as Parameters<typeof renderMetadataTableV2>[0])).toThrow(TypeError);
  });
  it('reconciles every metadata field with canonical authority', () => {
    const rules = rulesDocumentV2();
    const forgedRule = { ...rules.rules[0], cweIds: ['CWE-999'] };
    expect(() => serializeMetadataJsonV2({ ...rules, rules: [forgedRule, ...rules.rules.slice(1)] } as never)).toThrow(TypeError);

    const explain = emitExplainDocumentV2('N8N_EXECUTE_COMMAND', 'json');
    expect(explain.ok).toBe(true);
    if (explain.ok) {
      const forged = JSON.parse(explain.output) as Record<string, any>;
      forged.prose.remediationSteps[0] = 'forged';
      expect(() => serializeMetadataJsonV2(forged as never)).toThrow(TypeError);
      forged.prose.remediationSteps[0] = JSON.parse(explain.output).prose.remediationSteps[0];
      forged.provenance.semanticsDigest = '0'.repeat(64);
      expect(() => serializeMetadataJsonV2(forged as never)).toThrow(TypeError);
    }

    const profiles = JSON.parse(emitProfilesDocumentV2('json')) as Record<string, any>;
    profiles.profiles[0].capabilities[0].version = 'forged';
    expect(() => serializeMetadataJsonV2(profiles as never)).toThrow(TypeError);

    const version = JSON.parse(emitVersionDocumentV2('json')) as Record<string, any>;
    version.engine.version = 'forged';
    expect(() => serializeMetadataJsonV2(version as never)).toThrow(TypeError);
  });

  it('rejects non-index array properties at every nested level', () => {
    const normal = rulesDocumentV2();
    const rules = [...normal.rules] as unknown as Record<string, unknown>;
    rules.extra = true;
    expect(() => serializeMetadataJsonV2({ ...normal, rules } as never)).toThrow(TypeError);
  });

  it('preserves privacy and rejects nested unsafe paths or URLs', () => {
    const rules = emitRulesDocumentV2('json');
    expect(rules).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);

    // Explain with unsafe path or URL in prose
    const normal = rulesDocumentV2();
    const withPath = { ...normal, tool: { ...normal.tool, name: 'C:\\leak\\tool' } };
    expect(() => serializeMetadataJsonV2(withPath as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);
    const withUrl = { ...normal, tool: { ...normal.tool, name: 'https://evil.com' } };
    expect(() => serializeMetadataJsonV2(withUrl as unknown as Parameters<typeof serializeMetadataJsonV2>[0])).toThrow(TypeError);
  });
});
