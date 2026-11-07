import { describe, expect, it } from 'vitest';
import { buildSarifDocument } from './sarif-document.js';
import type { CanonicalScanFinding } from '../policy/policy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { parseWorkflowJson } from '../workflow.js';
import { scanWorkflowCore } from '../engine/engine.js';
import type { CoreAnalyzer } from '../engine/engine.js';
import { analyzeAiCapabilities } from '../analyzers/ai/ai-capability-analysis.js';
import { analyzeWorkflowJavaScript } from '../analyzers/code/javascript-analysis.js';
import { analyzeWorkflowPython } from '../analyzers/code/python-analysis.js';
import { analyzeWorkflowTaint, type TaintAnalysisResult } from '../analyzers/taint/taint-analysis.js';
import { resolvePolicyProfile } from '../policies/profile.js';
import { V1_GOLDEN_CASES } from '../__fixtures__/v1-goldens.js';

function finding(policyId: string, title = policyId, sourceSpan?: CanonicalScanFinding['location']['sourceSpan']): CanonicalScanFinding {
  return {
    policyId,
    title,
    severity: 'HIGH',
    location: { nodeName: 'Node', ...(sourceSpan ? { sourceSpan } : {}) },
    evidence: {},
    message: `Message for ${policyId}`,
    explanation: 'Explanation',
    whyItMatters: 'Why it matters',
    possibleImpact: 'Possible impact',
    remediation: 'Remediation',
    remediationSteps: ['Remediate'],
    confidence: 'HIGH',
    policyEffect: 'LEGACY_SCORE',
  };
}

function sarifDigest(document: Record<string, unknown>): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(document))));
}

// Derived from current native v1 SARIF bytes; changes require golden review.
// Re-pinned 2026-09-25 (golden review, not a restamp to force green): the only change on
// the emitting path is the tool driver's `informationUri`, which moved from
// github.com/jitwarr/n8n-Secureflow to github.com/jitwark/n8n-Secureflow when the owner's
// GitHub username changed. Proven by diff: packages/scanner-cli/src/sarif.ts and
// pipeline/cli/cli-output.ts each changed exactly one line — the URI constant — and these
// pins were green against the old bytes immediately before. The digests hash
// JSON.stringify(document), so a one-character URL change moves all of them.
const V1_SARIF_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  'safe:beta-default': 'da3e26d5cf76c65e2cd3c3ba358cbe21cc5a53b71028264ac26e213745f6ecb5',
  'safe:beta-hardened': 'da3e26d5cf76c65e2cd3c3ba358cbe21cc5a53b71028264ac26e213745f6ecb5',
  'risky:beta-default': 'b15e57a703c4f8bdd5a9291bebb00b2f300638060bb3379e764d75f893ba42a2',
  'risky:beta-hardened': 'b15e57a703c4f8bdd5a9291bebb00b2f300638060bb3379e764d75f893ba42a2',
  'analyzer-cap:beta-default': 'bdca084fac6c118088a249d7f90a786a93700d2fb275b7463110d26083b91ca3',
  'analyzer-cap:beta-hardened': 'd92d77903992f34d32e820299f50db17edc4cd307641df731bbe0ec4652ac340',
});

const goldenKey = (fixture: { id: string; profile: string }) => `${fixture.id}:${fixture.profile}`;

function nativeAnalyzers(profile: ReturnType<typeof resolvePolicyProfile>): readonly CoreAnalyzer[] {
  if (!profile.ok || !profile.includesJavaScriptAnalysis) return [];
  let propagation: TaintAnalysisResult['propagation'];
  return [analyzeWorkflowJavaScript, analyzeWorkflowPython,
    (workflow) => { const result = analyzeWorkflowTaint(workflow); propagation = result.propagation; return result; },
    (workflow) => propagation ? analyzeAiCapabilities(workflow, propagation) : { findings: [], diagnostics: [] }];
}

describe('buildSarifDocument', () => {
  it('emits a SARIF 2.1.0 envelope with the given tool identity', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [], notifications: [], executionSuccessful: true,
    });

    expect(document).toMatchObject({
      version: '2.1.0',
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    });
    const run = (document.runs as unknown[])[0] as Record<string, unknown>;
    expect(run.tool).toMatchObject({ driver: { name: 'n8n-scan', version: '0.1.0', informationUri: 'https://example.test', rules: [] } });
    expect(run.results).toEqual([]);
  });

  it('tags each rule with its CWE via the shared sarif-tags catalog', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [{ input: 'workflow.json', finding: finding('N8N_EXECUTE_COMMAND') }],
      executionSuccessful: true,
    });
    const run = (document.runs as Record<string, unknown>[])[0]!;
    const rules = (run.tool as Record<string, unknown>).driver as Record<string, unknown>;
    const rule = (rules.rules as Record<string, unknown>[])[0]!;

    expect((rule.properties as Record<string, unknown>).tags).toContain('external/cwe/cwe-078');
  });

  it('omits tags for a policy ID the catalog does not know', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [{ input: 'workflow.json', finding: finding('NOT_A_REAL_RULE') }],
      executionSuccessful: true,
    });
    const run = (document.runs as Record<string, unknown>[])[0]!;
    const driver = (run.tool as Record<string, unknown>).driver as Record<string, unknown>;
    const rule = (driver.rules as Record<string, unknown>[])[0]!;

    expect((rule.properties as Record<string, unknown> | undefined)).toBeUndefined();
  });

  it('sorts findings and rule descriptors by stable identifiers', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [
        { input: 'workflow.json', finding: finding('Z_RULE') },
        { input: 'workflow.json', finding: finding('A_RULE') },
      ],
      executionSuccessful: true,
    });
    const run = (document.runs as Record<string, unknown>[])[0]!;

    expect((run.results as Record<string, unknown>[]).map((item) => item.ruleId)).toEqual(['A_RULE', 'Z_RULE']);
    const driver = (run.tool as Record<string, unknown>).driver as Record<string, unknown>;
    expect((driver.rules as Record<string, unknown>[]).map((rule) => rule.id)).toEqual(['A_RULE', 'Z_RULE']);
  });

  it('omits locations without source spans and maps complete spans when present', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [
        { input: 'workflow.json', finding: finding('NO_SPAN') },
        { input: 'workflow.json', finding: finding('WITH_SPAN', 'With span', { start: { line: 2, column: 3, offset: 18 }, end: { line: 2, column: 12, offset: 27 } }) },
      ],
      executionSuccessful: true,
    });
    const run = (document.runs as Record<string, unknown>[])[0]!;
    const [withoutSpan, withSpan] = run.results as Record<string, unknown>[];

    expect(withoutSpan!.locations).toBeUndefined();
    expect(withSpan!.locations).toEqual([{
      physicalLocation: {
        artifactLocation: { uri: 'workflow.json' },
        region: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 12, charOffset: 18, charLength: 9 },
      },
    }]);
  });

  it('includes pre-built notifications verbatim and in the given order', () => {
    const document = buildSarifDocument({
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [], executionSuccessful: false,
      notifications: [{ descriptor: { id: 'INVALID_JSON' }, message: { text: 'bad.json: Invalid JSON.' }, properties: { input: 'bad.json' } }],
    });
    const run = (document.runs as Record<string, unknown>[])[0]!;
    const invocation = (run.invocations as Record<string, unknown>[])[0]!;

    expect(invocation).toMatchObject({ executionSuccessful: false });
    expect(invocation.toolExecutionNotifications).toEqual([
      { descriptor: { id: 'INVALID_JSON' }, message: { text: 'bad.json: Invalid JSON.' }, properties: { input: 'bad.json' } },
    ]);
  });

  it('is byte-identical across repeated calls with equivalent input', () => {
    const options = {
      toolName: 'n8n-scan', toolVersion: '0.1.0', informationUri: 'https://example.test',
      findings: [
        { input: 'workflow.json', finding: finding('B_RULE') },
        { input: 'workflow.json', finding: finding('A_RULE') },
      ],
      executionSuccessful: true,
    };

    expect(JSON.stringify(buildSarifDocument(options))).toBe(JSON.stringify(buildSarifDocument(options)));
  });

  it.each(V1_GOLDEN_CASES)('freezes native v1 SARIF bytes for $id/$profile', ({ id, json, profile }) => {
    const key = goldenKey({ id, profile });
    const parsed = parseWorkflowJson(json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolvePolicyProfile(profile);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const result = scanWorkflowCore(parsed.workflow, {
      policies: resolved.createPolicies(),
      analyzers: nativeAnalyzers(resolved),
      ruleCatalog: resolved.ruleCatalog,
    });
    const document = buildSarifDocument({
      toolName: 'n8n-scan',
      toolVersion: '0.1.0',
      informationUri: 'https://github.com/jitwark/n8n-Secureflow',
      findings: result.findings.map((item) => ({ input: id, finding: item })),
      executionSuccessful: result.analysisStatus !== 'INDETERMINATE',
    });
    expect(sarifDigest(document)).toBe(V1_SARIF_DIGESTS[key]);
    expect(JSON.stringify(document)).toBe(JSON.stringify(buildSarifDocument({
      toolName: 'n8n-scan',
      toolVersion: '0.1.0',
      informationUri: 'https://github.com/jitwark/n8n-Secureflow',
      findings: result.findings.map((item) => ({ input: id, finding: item })),
      executionSuccessful: result.analysisStatus !== 'INDETERMINATE',
    })));
  });
});
