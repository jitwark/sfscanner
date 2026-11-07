import {
  scanWorkflowCore,
  type CoreAnalyzer,
  type ScanWorkflowCoreResult,
} from '@hub/scanner-core/engine';
import {
  analyzeAiCapabilities,
} from '@hub/scanner-core/analyzers/ai/ai-capability-analysis';
import {
  analyzeWorkflowJavaScript,
} from '@hub/scanner-core/analyzers/code/javascript-analysis';
import {
  analyzeWorkflowPython,
} from '@hub/scanner-core/analyzers/code/python-analysis';
import {
  analyzeWorkflowTaint,
} from '@hub/scanner-core/analyzers/taint/taint-analysis';
import {
  resolvePolicyProfile,
  type PolicyProfileEntry,
  type PolicyProfileId,
} from '@hub/scanner-core/policies/profile';
import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';
import type { ScanPolicy as CoreScanPolicy } from '@hub/scanner-core/policy';
import type { ScanPolicy } from '@hub/scanner-core/policy';

export type ScannerCoreAdapterOptions = {
  profileId: PolicyProfileId;
  approvedDomains?: readonly string[];
  policies?: readonly ScanPolicy[];
  ambiguousNodeIds?: ReadonlySet<string>;
  maxAnalyzerFindings?: number;
};

export function scanWithScannerCore(
  workflow: NormalizedWorkflow,
  options: ScannerCoreAdapterOptions,
): ScanWorkflowCoreResult {
  const profile = resolvePolicyProfile(options.profileId);
  if (!profile.ok) {
    throw new Error(`Unknown scanner profile: ${profile.profileId}`);
  }

  const policies = options.policies === undefined
    ? profile.createPolicies({ approvedDomains: options.approvedDomains })
    : adaptPolicies(options.policies, workflow);

  return scanWorkflowCore(workflow, {
    policies,
    analyzers: createAnalyzers(profile),
    ruleCatalog: profile.ruleCatalog,
    maxAnalyzerFindings: options.maxAnalyzerFindings,
    ambiguousNodeIds: options.ambiguousNodeIds,
  });
}

function adaptPolicies(
  policies: readonly ScanPolicy[],
  workflow: NormalizedWorkflow,
): CoreScanPolicy[] {
  return policies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    description: policy.description,
    evaluate: () => policy.evaluate(workflow),
  }));
}

/**
 * The analyzer list the engine runs. Each analyzer is a pure function of the workflow: the engine
 * collects their findings in list order, so no analyzer may depend on another having already run.
 */
export function createAnalyzers(profile: PolicyProfileEntry): CoreAnalyzer[] {
  const analyzers: CoreAnalyzer[] = [];
  if (profile.includesJavaScriptAnalysis) {
    analyzers.push((workflow) => analyzeWorkflowJavaScript(workflow));
  }
  if (profile.includesPythonAnalysis) {
    analyzers.push((workflow) => analyzeWorkflowPython(workflow));
  }
  if (profile.includesTaintAnalysis) {
    // Taint and the AI-capability stage that reads it stay in one analyzer: the propagation value is
    // owned by this call, so the AI findings cannot depend on the engine running a taint analyzer
    // before this one, and `analyzeWorkflowTaint` still runs once per workflow.
    analyzers.push((workflow) => {
      const taint = analyzeWorkflowTaint(workflow);
      const ai = analyzeAiCapabilities(workflow, taint.propagation);
      return {
        findings: [...taint.findings, ...ai.findings],
        diagnostics: [...taint.diagnostics, ...ai.diagnostics],
      };
    });
  }
  return analyzers;
}
