/** SPDX ids we treat as redistributable. Static allowlist, deliberately short. */
export const REDISTRIBUTABLE_LICENCES: Record<string, true> = {
  'MIT': true,
  'Apache-2.0': true,
  'BSD-2-Clause': true,
  'BSD-3-Clause': true,
  'ISC': true,
  'CC0-1.0': true,
  'Unlicense': true,
};

/** Hard limits. Shared by acquisition, the worker, and the browser scanner. */
export const LIMITS = {
  maxWorkflowBytes: 1_536_000,
  maxNodes: 5_000,
  scanTimeoutMs: 30_000,
  packSize: 250,
  shardSize: 2_000,
  maxPublicFindings: 20,
} as const;
