import assert from 'node:assert/strict';

const PACKAGE_EXPORTS = Object.freeze([
  '@hub/scanner-core/canonical-json',
  '@hub/scanner-core/workflow',
  '@hub/scanner-core/scanner-version',
  '@hub/scanner-core/redaction',
  '@hub/scanner-core/policy',
  '@hub/scanner-core/policy-helpers',
  '@hub/scanner-core/rule-catalog',
  '@hub/scanner-core/provider-token-patterns',
  '@hub/scanner-core/analyzers/code/javascript-analysis',
  '@hub/scanner-core/analyzers/code/python-analysis',
  '@hub/scanner-core/analyzers/taint/taint-analysis',
  '@hub/scanner-core/analyzers/ai/ai-capability-analysis',
  '@hub/scanner-core/graph-dominators',
  '@hub/scanner-core/result/canonical-findings',
  '@hub/scanner-core/result/analysis-completeness',
  '@hub/scanner-core/result/analysis-diagnostics-collection',
  '@hub/scanner-core/result/summary',
  '@hub/scanner-core/policies/profile',
  '@hub/scanner-core/engine',
  '@hub/scanner-core/report/sarif-tags',
  '@hub/scanner-core/report/sarif-document',
]);
const PROHIBITED_RUNTIME_MODULE = /(?:^| )(?:node:)?(?:fs|path|process|buffer|module|child_process|worker_threads|http|https|net|tls|os|stream)(?:\/|$)/i;
const SECRET = 'Bearer bare-node-secret-123';

async function loadPackageExports() {
  const namespaces = new Map();
  for (const specifier of PACKAGE_EXPORTS) {
    try {
      const namespace = await import(specifier);
      assert.equal(typeof namespace, 'object', `package export did not resolve to a module: ${specifier}`);
      namespaces.set(specifier, namespace);
    } catch (error) {
      throw new Error(`package export failed to resolve: ${specifier}; ${errorMessage(error)}`);
    }
  }
  return namespaces;
}

function requiredExport(namespaces, specifier, name) {
  const value = namespaces.get(specifier)?.[name];
  assert.notEqual(value, undefined, `package export ${specifier} is missing ${name}`);
  return value;
}

function finding(nodeFinding, node, policyId, title) {
  return nodeFinding({
    policyId,
    title: `${title}: ${SECRET}`,
    severity: 'HIGH',
    node,
    evidence: { authorization: SECRET, nested: { token: SECRET } },
    message: `Synthetic finding contains ${SECRET}.`,
    explanation: 'The synthetic finding exercises the standalone scanner core.',
    whyItMatters: 'Secrets in workflow configuration can cross a trust boundary.',
    possibleImpact: 'A copied workflow could disclose credential material.',
    remediation: 'Replace literal credentials with a managed reference.',
    remediationSteps: ['Replace literal credentials with a managed reference.'],
    confidence: 'HIGH',
  });
}

function assertBareNodeRuntime(beforeImports) {
  assert.equal(typeof globalThis.window, 'undefined', 'browser window global is unexpectedly present');
  assert.equal(typeof globalThis.document, 'undefined', 'browser document global is unexpectedly present');
  assert.equal(typeof globalThis.Worker, 'undefined', 'Worker shim/global is unexpectedly present');

  const loaded = (process.moduleLoadList ?? [])
    .filter((entry) => !beforeImports.has(entry) && PROHIBITED_RUNTIME_MODULE.test(entry));
  assert.deepEqual(loaded, [], `prohibited runtime module(s) loaded: ${loaded.join(', ')}`);
}

async function runSmoke() {
  const beforeImports = new Set(process.moduleLoadList ?? []);
  const namespaces = await loadPackageExports();
  assertBareNodeRuntime(beforeImports);

  const parseWorkflowJson = requiredExport(namespaces, '@hub/scanner-core/workflow', 'parseWorkflowJson');
  const scanWorkflowCore = requiredExport(namespaces, '@hub/scanner-core/engine', 'scanWorkflowCore');
  const nodeFinding = requiredExport(namespaces, '@hub/scanner-core/policy-helpers', 'nodeFinding');
  const betaDefaultRuleCatalog = requiredExport(namespaces, '@hub/scanner-core/rule-catalog', 'betaDefaultRuleCatalog');
  const resolvePolicyProfile = requiredExport(namespaces, '@hub/scanner-core/policies/profile', 'resolvePolicyProfile');
  const scannerVersion = requiredExport(namespaces, '@hub/scanner-core/scanner-version', 'SCANNER_VERSION');
  assert.ok(Array.isArray(betaDefaultRuleCatalog), 'default rule catalog export is not an array');
  assert.equal(resolvePolicyProfile('beta-default').ok, true, 'default scanner profile failed to resolve');
  assert.equal(resolvePolicyProfile('beta-hardened').ok, true, 'hardened scanner profile failed to resolve');
  assert.equal(resolvePolicyProfile('beta-default').version, scannerVersion, 'profile version drifted from scanner identity');

  const source = JSON.stringify({
    name: 'Bare Node synthetic workflow',
    nodes: [{
      id: 'node-1',
      name: 'Secret HTTP request',
      type: 'n8n-nodes-base.httpRequest',
      parameters: { headers: { Authorization: SECRET } },
    }],
    connections: {},
  });
  const parsed = parseWorkflowJson(source);
  assert.equal(parsed.ok, true, 'synthetic workflow failed to parse');
  const workflow = parsed.workflow;
  const policyFinding = (node) => finding(nodeFinding, node, 'BARE_NODE_POLICY', 'Synthetic policy finding');
  const analyzerFinding = (node) => finding(nodeFinding, node, 'BARE_NODE_ANALYZER', 'Synthetic analyzer finding');
  const options = {
    policies: [{
      id: 'bare-node-policy',
      name: 'Bare Node policy',
      description: 'Synthetic policy for standalone package smoke coverage.',
      evaluate: (input) => [policyFinding(input.nodes[0])],
    }],
    analyzers: [(input) => ({ findings: [analyzerFinding(input.nodes[0])], diagnostics: [] })],
    ruleCatalog: [
      ...betaDefaultRuleCatalog,
      {
        policyId: 'BARE_NODE_POLICY', defaultSeverity: 'HIGH', defaultConfidence: 'HIGH',
        precision: 'HIGH', policyEffect: 'LEGACY_SCORE', curationAction: 'NONE', serveAction: 'DISPLAY',
      },
      {
        policyId: 'BARE_NODE_ANALYZER', defaultSeverity: 'HIGH', defaultConfidence: 'HIGH',
        precision: 'HIGH', policyEffect: 'REPORT_ONLY', curationAction: 'REVIEW', serveAction: 'DISPLAY',
      },
    ],
  };

  const first = scanWorkflowCore(workflow, options);
  const second = scanWorkflowCore(workflow, options);
  const firstSerialized = JSON.stringify(first);
  assert.equal(JSON.stringify(second), firstSerialized, 'repeated scan serialization is not byte-identical');
  assert.equal(first.findings.length, 2, 'synthetic policy/analyzer scan did not return two findings');
  assert.equal(first.findings[0].policyEffect, 'LEGACY_SCORE', 'policy finding lost its catalog effect');
  assert.equal(first.findings[1].policyEffect, 'REPORT_ONLY', 'analyzer finding lost its catalog effect');
  assert.match(firstSerialized, /\[REDACTED\]/, 'scanner findings contain no redaction marker');
  assert.equal(firstSerialized.includes(SECRET), false, 'scanner findings still contain the synthetic secret');
  return { exportCount: namespaces.size, findingCount: first.findings.length };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

try {
  const result = await runSmoke();
  console.log(`scanner-core bare-node smoke passed: exports=${result.exportCount}, findings=${result.findingCount}, deterministic=yes, redacted=yes, runtime=bare-node`);
} catch (error) {
  console.error(`scanner-core bare-node smoke failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
