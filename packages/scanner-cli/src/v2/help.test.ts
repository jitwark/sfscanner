import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import {
  COMMAND_HELP_V2,
  GENERAL_HELP_V2,
  V2_COMMANDS,
  V2_EXIT_CODES,
  V2_EXIT_REASONS,
  V2_LIMITS,
  getHelpV2,
} from './help';

describe('v2 help authority', () => {
  it('has the closed command, option, exit-code, and reason vocabulary', () => {
    expect(V2_COMMANDS).toEqual(['scan', 'fix', 'rules', 'explain', 'profiles', 'validate-config', 'version']);
    expect(V2_EXIT_CODES).toEqual([0, 1, 2, 3, 4, 130]);
    expect(V2_EXIT_REASONS).toEqual([
      'CANCELLED', 'INTERNAL', 'USAGE', 'FINDING_THRESHOLD', 'REQUIRE_COMPLETE', 'ITEM_FAILURE',
      'UNDER_THRESHOLD',
    ]);
    expect(Object.keys(COMMAND_HELP_V2)).toEqual([...V2_COMMANDS]);
  });

  it('advertises only parser-supported fix options without leaking fix flags to other commands', () => {
    const fixOnly = ['--confirm', '--endpoint-receipt', '--fix', '--input', '--mapping', '--root'];
    for (const command of V2_COMMANDS) {
      const options = [...getHelpV2(command).matchAll(/^  (--[a-z][a-z0-9-]*)\b/gm)]
        .map((match) => match[1]!).sort();
      if (command === 'fix') expect(options).toEqual([...fixOnly, '--schema'].sort());
      else expect(options.filter((name) => fixOnly.includes(name))).toEqual([]);
    }
  });

  it('states defaults, limits, and profile admission truth', () => {
    expect(GENERAL_HELP_V2).toContain('format: json');
    expect(GENERAL_HELP_V2).toContain('profile: beta-default');
    expect(GENERAL_HELP_V2).toContain('fail-on: INFO');
    expect(GENERAL_HELP_V2).toContain('concurrency: 1 (maximum 16)');
    expect(GENERAL_HELP_V2).toContain('require-complete: false');
    expect(GENERAL_HELP_V2).toContain('include: **/*.json');
    expect(GENERAL_HELP_V2).toContain('exclude: .git/**, node_modules/**');
    expect(GENERAL_HELP_V2).toContain('beta-hardened@2.0.0: defined but not admitted or selectable');
    expect(GENERAL_HELP_V2).toContain('maxSerializedResultBytes=5000000');
    expect(GENERAL_HELP_V2).toContain('maxRuleOperations=1000000');
    expect(GENERAL_HELP_V2).toContain('maxSourceWork=1000000');
    expect(getHelpV2('scan')).toContain('--allow-unsigned-development-rules');
    expect(getHelpV2('profiles')).toContain('beta-hardened');
  });

  it('states the worker deadline from the limits contract, not a restated number', () => {
    const deadline = DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs;
    expect(V2_LIMITS.workerDeadlineMs).toBe(deadline);
    expect(getHelpV2('scan')).toContain(`Default: ${String(deadline)} (workerDeadlineMs)`);
    expect(GENERAL_HELP_V2).toContain(`timeout: ${String(deadline)}ms.`);
  });

  it('renders deterministic LF-only text without machine paths or secret values', () => {
    expect(getHelpV2()).toBe(GENERAL_HELP_V2);
    expect(getHelpV2()).toBe(getHelpV2());
    for (const text of [GENERAL_HELP_V2, ...Object.values(COMMAND_HELP_V2)]) {
      expect(text).not.toMatch(/\r/);
      expect(text).not.toMatch(/(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/)/);
      expect(text).not.toMatch(/(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    }
  });

  it('exposes every configured v2 limit in stable field order', () => {
    expect(Object.keys(V2_LIMITS)).toEqual([
      'maxBytes', 'maxNodes', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth', 'maxParameterLeaves',
      'workerDeadlineMs', 'maxSyntaxNodes', 'maxDocumentDepth', 'maxMembersAndElements', 'maxRawEdges',
      'maxDuplicateKeys', 'maxDiagnostics', 'maxStoredSourceSpans', 'maxSourceWork', 'maxExpressionTokens',
      'maxCodeSyntaxNodes',
      'maxGraphOperations', 'maxTaintStates', 'maxTraceStepsPerFinding', 'maxFindings', 'maxRedactionPatches',
      'maxRedactedArtifactBytes', 'maxEvidenceBytes', 'maxSerializedResultBytes', 'maxRuleOperations',
    ]);
  });
});
