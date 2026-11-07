import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime packages scanner-core may import. Each is browser-safe (pure JS, no Node builtin), so it can
 * ship inside the browser worker: `@noble/curves` verifies v2 rule-pack Ed25519 signatures and enters
 * on the same ground as `@noble/hashes`. The prohibited Node-builtin imports stay governed by
 * `prohibitedSpecifier` in scanner-core-source-audit.mjs, not by this list.
 */
export const allowedRuntimePackages = new Set(['@hub/contracts', '@humanwhocodes/momoa', '@noble/curves', '@noble/hashes', '@lezer/python', 'acorn']);

export function checkExports(packageRoot, exportsField, errors) {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    errors.push('package exports must be an explicit object');
    return;
  }
  const entries = Object.entries(exportsField);
  if (entries.some(([key]) => key.includes('*'))) {
    errors.push('package exports must not contain wildcard keys');
  }

  checkExplicitExport(packageRoot, exportsField, './canonical-json', './src/canonical-json.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './workflow', './src/workflow.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './scanner-version', './src/scanner-version.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './redaction', './src/redaction/redaction.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './policy', './src/policy/policy.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './policy-helpers', './src/policy/policy-helpers.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './rule-catalog', './src/policy/rule-catalog.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './provider-token-patterns', './src/provider-token-patterns.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/code/javascript-analysis', './src/analyzers/code/javascript-analysis.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/code/python-analysis', './src/analyzers/code/python-analysis.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/taint/taint-analysis', './src/analyzers/taint/taint-analysis.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/taint/taint-lattice', './src/analyzers/taint/taint-lattice.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/taint/taint-propagation', './src/analyzers/taint/taint-propagation.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/taint/taint-sources', './src/analyzers/taint/taint-sources.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/taint/taint-traces', './src/analyzers/taint/taint-traces.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './analyzers/ai/ai-capability-analysis', './src/analyzers/ai/ai-capability-analysis.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './graph-dominators', './src/graph-dominators.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './result/canonical-findings', './src/result/canonical-findings.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './result/analysis-completeness', './src/result/analysis-completeness.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './result/analysis-diagnostics-collection', './src/result/analysis-diagnostics-collection.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './result/summary', './src/result/summary.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './policies/profile', './src/policies/profile.ts', errors);
  checkExplicitExport(packageRoot, exportsField, './engine', './src/engine/engine.ts', errors);
}

function checkExplicitExport(packageRoot, exportsField, key, expectedTarget, errors) {
  if (!Object.hasOwn(exportsField, key)) {
    errors.push(`package exports must include an explicit ${key} entry`);
    return;
  }

  const entry = exportsField[key];
  const targets = typeof entry === 'string' ? [entry] : [entry?.types, entry?.import, entry?.default].filter(Boolean);
  if (targets.some((target) => target !== expectedTarget)) {
    errors.push(`${key} must explicitly target ${expectedTarget}`);
  }
  if (!existsSync(join(packageRoot, expectedTarget.replace(/^\.\//, '')))) {
    errors.push(`${key.slice(2)} export target is missing`);
  }
}
