import { DEFAULT_SCANNER_LIMITS, SCANNER_RESULT_SCHEMA_VERSION, toWorkflowParseOptions } from '@hub/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../canonical-json.js';
import { scanWorkflowCore } from '../engine/engine.js';
import type { CoreAnalyzer } from '../engine/engine.js';
import { analyzeAiCapabilities } from '../analyzers/ai/ai-capability-analysis.js';
import { analyzeWorkflowJavaScript } from '../analyzers/code/javascript-analysis.js';
import { analyzeWorkflowPython } from '../analyzers/code/python-analysis.js';
import { analyzeWorkflowTaint, type TaintAnalysisResult } from '../analyzers/taint/taint-analysis.js';
import { resolvePolicyProfile } from '../policies/profile.js';
import { SCANNER_VERSION } from '../scanner-version.js';
import { parseWorkflowJson } from '../workflow.js';
import { V1_GOLDEN_CASES } from '../__fixtures__/v1-goldens.js';

function digest(value: unknown): string {
  const serialized = canonicalizeJson(JSON.parse(JSON.stringify(value)));
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

function compatibilityProjection(result: ReturnType<typeof scanWorkflowCore>, profileId: string): unknown {
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    scannerVersion: SCANNER_VERSION,
    policyProfile: profileId,
    analysisStatus: result.analysisStatus,
    analysisDiagnostics: result.diagnostics,
    summary: result.summary,
    findings: result.findings.map((finding) => {
      const { sourceSpan: _sourceSpan, ...location } = finding.location;
      return { ...finding, location };
    }),
  };
}

function analyzersFor(profile: ReturnType<typeof resolvePolicyProfile>): readonly CoreAnalyzer[] {
  if (!profile.ok || !profile.includesJavaScriptAnalysis) return [];
  const analyzers: CoreAnalyzer[] = [analyzeWorkflowJavaScript, analyzeWorkflowPython];
  let propagation: TaintAnalysisResult['propagation'];
  analyzers.push((workflow) => {
    const result = analyzeWorkflowTaint(workflow);
    propagation = result.propagation;
    return result;
  });
  analyzers.push((workflow) => propagation ? analyzeAiCapabilities(workflow, propagation) : { findings: [], diagnostics: [] });
  return analyzers;
}

describe('native scanner-result-v1 goldens', () => {
  it.each(V1_GOLDEN_CASES)('keeps the core result digest frozen for $id', (fixture) => {
    const parsed = parseWorkflowJson(fixture.json, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const profile = resolvePolicyProfile(fixture.profile);
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const result = scanWorkflowCore(parsed.workflow, {
      policies: profile.createPolicies(),
      analyzers: analyzersFor(profile),
      ruleCatalog: profile.ruleCatalog,
      maxAnalyzerFindings: 100,
    });
    expect(digest(compatibilityProjection(result, fixture.profile))).toBe(fixture.expectedDigest);
  });
});
