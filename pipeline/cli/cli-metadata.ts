import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import { resolvePolicyProfile, type PolicyProfileId } from '@hub/scanner-core/policies/profile';
import type { CliHelpTopic } from './cli-contract.js';

export type CliRule = {
  policyId: string;
  name: string;
  description: string;
  severity: string;
  remediation: string;
};

export function listCliRules(profile: PolicyProfileId = 'beta-default'): CliRule[] {
  const resolved = resolvePolicyProfile(profile);
  if (!resolved.ok) return [];
  const policies = resolved.createPolicies({ approvedDomains: ['example.invalid'] });
  return resolved.ruleCatalog.map((rule) => {
    const policy = policies.find((candidate) => candidate.id === rule.policyId);
    return {
      policyId: rule.policyId,
      name: policy?.name ?? rule.policyId,
      description: policy?.description ?? 'Hardened analyzer rule reported by the scanner profile.',
      severity: rule.defaultSeverity,
      remediation: REMEDIATIONS[rule.policyId] ?? 'Review the finding evidence and apply the scanner guidance before deployment.',
    };
  });
}

export function explainCliRule(policyId: string, profile: PolicyProfileId = 'beta-default'): CliRule | undefined {
  return listCliRules(profile).find((rule) => rule.policyId === policyId);
}

export function renderRules(profile: PolicyProfileId = 'beta-default'): string {
  return `${listCliRules(profile).map((rule) => `${rule.policyId}\t${rule.severity}\t${rule.name}`).join('\n')}\n`;
}

export function renderExplanation(rule: CliRule): string {
  return [`${rule.policyId}: ${rule.name}`, `Severity: ${rule.severity}`, rule.description, `Remediation: ${rule.remediation}`, ''].join('\n');
}

export function renderHelp(topic: CliHelpTopic = 'general'): string {
  return topic === 'scan' ? renderScanHelp() : renderGeneralHelp();
}

function renderGeneralHelp(): string {
  return [
    'n8n-scan — deterministic n8n workflow scanner',
    '',
    'Usage:',
    '  n8n-scan scan <file|directory|-> [options]',
    '  n8n-scan rules',
    '  n8n-scan explain <policy-id>',
    '  n8n-scan version [--json]',
    '',
    'Commands:',
    '  scan       Scan workflow JSON from files, directories, or stdin.',
    '  rules      List scanner rules.',
    '  explain    Explain one scanner rule.',
    '  version    Print CLI and scanner versions.',
    '',
    'Options:',
    '  --help     Show this help text.',
    '  --version  Print the CLI version.',
    '',
    'Run "n8n-scan scan --help" for scan options.',
    '',
  ].join('\n');
}

function renderScanHelp(): string {
  return [
    'n8n-scan scan — scan n8n workflow JSON',
    '',
    'Usage:',
    '  n8n-scan scan <file|directory|-> [options]',
    '',
    'Inputs:',
    '  file       Scan one workflow JSON file.',
    '  directory  Recursively scan JSON files.',
    '  -          Read one workflow JSON document from stdin.',
    '',
    'Options:',
    '  --format <table|json|sarif>       Select output format (default: table).',
    '  --output <path>                   Write output atomically instead of stdout.',
    '  --profile <beta-default|beta-hardened>',
    '                                    Select the scanner policy profile.',
    '  --approved-domain <domain>        Allow a domain; repeat for multiple domains.',
    '  --fail-on <severity|indeterminate> Exit 1 at a finding severity or on an indeterminate scan.',
    '  --max-concurrency <positive-int>  Bound concurrent inputs (max 16).',
    '  --timeout <positive-int>           Hard per-scan limit in ms (max 2147483647); timeout terminates the worker and exits 130.',
    '  --include <glob>                  Include matching directory paths.',
    '  --exclude <glob>                  Exclude matching directory paths.',
    '  --no-color                        Disable color in human-readable output.',
    '  Ctrl-C                             Cancel scans; exits 130 without replacing --output.',
    '  --help                             Show this help text.',
    '',
  ].join('\n');
}

export const CLI_VERSION_DOCUMENT = Object.freeze({
  schemaVersion: 'scanner-cli-v1',
  cliVersion: '0.1.0',
  scannerVersion: SCANNER_VERSION,
  profiles: ['beta-default', 'beta-hardened'],
});

const REMEDIATIONS: Record<string, string> = {
  N8N_EXECUTE_COMMAND: 'Remove shell execution or isolate it behind strict approval.',
  N8N_CODE_NODE: 'Review custom code for secret access, outbound requests, and unsafe parsing.',
  RAW_AUTH_HEADER: 'Use n8n credentials or a managed secret reference instead of a raw header.',
  RAW_SECRET_INDICATOR: 'Move the value into n8n credentials and rotate any exposed secret.',
  UNAPPROVED_DOMAIN: 'Approve the destination only after security review, or replace the call.',
  UNKNOWN_NODE_PACKAGE: 'Verify the package source, version, permissions, and maintenance status.',
  WEBHOOK_EXPOSURE: 'Require webhook authentication or place the endpoint behind trusted controls.',
};
