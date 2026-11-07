import type { FixPlanV1, FixPrerequisiteEvidenceV1, FixSuggestionFactV1 } from '@hub/scanner-core/remediation/fix-suggestion';
import type { CliFixCommandV2 } from './arguments';
import {
  applyFixV1,
  type FixApplyHostV1,
  type FixApplyRequestV1,
  type FixApplyResultV1,
} from './fix-apply';
import { runFixPlanV2, type FixPlanHostV1, type FixPlanRequestV1, type FixPlanRunResultV1 } from './fix-plan';
import { toFsPathV2 } from './path-admission';

/**
 * Dispatch for `fix suggest` and `fix apply`. It builds the planner request from the parsed
 * command, hands it to the planner adapter, and only forwards a READY plan to the apply adapter.
 * No patch algorithm, path policy or prerequisite inference lives here: node selection is a
 * lookup in the caller-supplied suggestion catalogue, receipts are read by the planner, and the
 * write is a capability the apply host must expose.
 *
 * A suggestion fact has no producer inside the scanner yet (public fact emission is reserved),
 * so the catalogue is supplied by the process that owns the suggestions. `--fix` selects one by
 * ID; a single-entry catalogue is the unambiguous selection.
 */

export type FixCommandExitCodeV2 = 0 | 2 | 3 | 130;
export type FixCommandStatusV2 =
  | 'READY' | 'REFUSED' | 'FAILED' | 'CANCELLED' | 'HOST_UNSUPPORTED'
  | 'WRITTEN' | 'SOURCE_CONFLICT' | 'WRITE_FAILED_UNCHANGED' | 'RECOVERY_REQUIRED';

export type FixCommandDocumentV2 = Readonly<{
  schemaVersion: 'n8n-scan-fix-v2';
  action: 'suggest' | 'apply' | 'unknown';
  status: FixCommandStatusV2;
  code?: string;
  reason?: string;
  message?: string;
  suggestionId?: string;
  suggestion?: FixSuggestionFactV1;
  plan?: FixPlanV1;
  prerequisites?: readonly FixPrerequisiteEvidenceV1[];
  apply?: FixApplyResultV1;
}>;

export type FixCommandResultV2 = Readonly<{
  exitCode: FixCommandExitCodeV2;
  stdout: string;
  stderr: string;
  document?: FixCommandDocumentV2;
}>;

export type FixCommandOptionsV2 = Readonly<{
  signal?: AbortSignal;
  /** Internal planner/apply seams for embedding and tests. */
  planHost?: FixPlanHostV1;
  applyHost?: FixApplyHostV1;
  /** Serialized patched document; required before an apply host may be dispatched. */
  result?: Uint8Array;
}>;

/** A catalogue producer, awaited once per command after the shape and cancellation checks. */
export type FixSuggestionProviderV2 = (command: CliFixCommandV2) => Promise<readonly FixSuggestionFactV1[]>;

export type FixCommandDepsV2 = Readonly<{
  /** Reviewed suggestions this process already holds, or the provider that builds them. */
  suggestions?: readonly FixSuggestionFactV1[] | FixSuggestionProviderV2;
  /** Non-receipt prerequisite evidence owned by the caller (for example a review record). */
  evidence?: readonly FixPrerequisiteEvidenceV1[];
  plan?: typeof runFixPlanV2;
  apply?: typeof applyFixV1;
}>;

const SCHEMA_VERSION = 'n8n-scan-fix-v2' as const;
const NO_SUGGESTIONS: readonly FixSuggestionFactV1[] = Object.freeze([]);
const NO_EVIDENCE: readonly FixPrerequisiteEvidenceV1[] = Object.freeze([]);
const NO_CONDITIONAL_REPLACE = 'NO_CONDITIONAL_REPLACE';

type ShapeV2 =
  | Readonly<{ ok: true; command: CliFixCommandV2 }>
  | Readonly<{ ok: false; message: string }>;

export async function runFixCommandV2(
  command: CliFixCommandV2,
  options: FixCommandOptionsV2 = {},
  deps: FixCommandDepsV2 = {},
): Promise<FixCommandResultV2> {
  const shaped = commandShape(command);
  if (!shaped.ok) return failed('unknown', 'USAGE', shaped.message, 2);
  const parsed = shaped.command;
  if (options.signal?.aborted) return cancelled(parsed.action);
  let catalogue: readonly FixSuggestionFactV1[];
  try {
    catalogue = typeof deps.suggestions === 'function' ? await deps.suggestions(parsed) : deps.suggestions ?? NO_SUGGESTIONS;
  } catch {
    if (options.signal?.aborted) return cancelled(parsed.action);
    return failed(parsed.action, 'SERVICE_FAILURE', 'The suggestion provider failed.', 3);
  }
  if (options.signal?.aborted) return cancelled(parsed.action);
  if (!Array.isArray(catalogue)) return failed(parsed.action, 'SERVICE_FAILURE', 'The suggestion provider returned no catalogue.', 3);

  const selected = selectSuggestion(parsed.fix, catalogue);
  if (!selected.ok) return failed(parsed.action, 'NO_SUGGESTION', selected.message, 3);

  const request: FixPlanRequestV1 = Object.freeze({
    root: parsed.root,
    input: parsed.input,
    suggestion: selected.suggestion,
    ...(parsed.mapping === undefined ? {} : { mapping: parsed.mapping }),
    ...(parsed.endpointReceipt === undefined ? {} : { endpointReceipt: parsed.endpointReceipt }),
    evidence: prerequisiteEvidence(deps.evidence ?? NO_EVIDENCE, parsed, selected.suggestion),
  });

  const plan = deps.plan ?? runFixPlanV2;
  let planned: FixPlanRunResultV1;
  try {
    planned = await plan(request, options.planHost);
  } catch {
    if (options.signal?.aborted) return cancelled(parsed.action);
    return failed(parsed.action, 'SERVICE_FAILURE', 'The fix planner failed.', 3, selected.suggestion);
  }

  const suggestionFields = { suggestionId: selected.suggestion.id, suggestion: selected.suggestion };
  if (!planned.ok) {
    const exitCode: FixCommandExitCodeV2 = planned.code === 'USAGE' ? 2 : 3;
    return emit(exitCode, document(parsed.action, { ...suggestionFields, status: 'FAILED', code: planned.code, message: planned.message }), planned.message);
  }

  const plannedFields = Object.freeze({
    ...suggestionFields,
    plan: planned.plan,
    prerequisites: planned.prerequisites,
  });
  if (parsed.action === 'suggest') {
    return emit(
      planned.plan.status === 'READY' ? 0 : 3,
      document('suggest', { ...plannedFields, status: planned.plan.status }),
      planned.plan.status === 'READY' ? undefined : `Fix suggest REFUSED (${planned.plan.reason})`,
    );
  }
  if (options.signal?.aborted) return cancelled('apply');
  if (planned.plan.status !== 'READY') {
    return emit(3, document('apply', { ...plannedFields, status: 'REFUSED' }), `Fix apply REFUSED (${planned.plan.reason})`);
  }
  // The host capability is the authority for conditional replacement. Without it nothing is
  // staged, no backup is created and the source is never opened for write; the READY plan and
  // its suggestion stay available in the document.
  if (options.applyHost?.conditionalReplace === undefined) {
    return emit(3, document('apply', { ...plannedFields, status: 'HOST_UNSUPPORTED', reason: NO_CONDITIONAL_REPLACE }), `Fix apply HOST_UNSUPPORTED (${NO_CONDITIONAL_REPLACE})`);
  }
  if (!(options.result instanceof Uint8Array)) {
    return failed('apply', 'USAGE', 'The apply dispatch requires the planned result bytes.', 2, selected.suggestion, plannedFields);
  }

  const applyRequest: FixApplyRequestV1 = Object.freeze({
    plan: planned.plan,
    root: parsed.root,
    target: toFsPathV2(parsed.root, parsed.input),
    result: options.result,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const apply = deps.apply ?? applyFixV1;
  let applied: FixApplyResultV1;
  try {
    applied = await apply(applyRequest, options.applyHost);
  } catch {
    if (options.signal?.aborted) return cancelled('apply');
    return failed('apply', 'SERVICE_FAILURE', 'The fix apply service failed.', 3, selected.suggestion, plannedFields);
  }

  const exitCode: FixCommandExitCodeV2 = applied.status === 'WRITTEN' ? 0 : applied.status === 'CANCELLED' ? 130 : 3;
  const reason = 'reason' in applied ? ` (${applied.reason})` : '';
  return emit(exitCode, document('apply', { ...plannedFields, status: applied.status, apply: applied }), `Fix apply ${applied.status}${reason}`);
}

function commandShape(command: unknown): ShapeV2 {
  if (typeof command !== 'object' || command === null) return { ok: false, message: 'A fix command is required.' };
  const record = command as Record<string, unknown>;
  if (record.kind !== 'fix') return { ok: false, message: 'The fix dispatcher accepts only fix commands.' };
  if (record.schema !== 'v2') return { ok: false, message: 'Fix commands require schema v2.' };
  if (record.action !== 'suggest' && record.action !== 'apply') return { ok: false, message: 'Fix requires the suggest or apply action.' };
  if (typeof record.root !== 'string' || typeof record.input !== 'string') return { ok: false, message: 'Fix requires a root and an input.' };
  if (record.action === 'apply' && record.confirm !== true) return { ok: false, message: 'Fix apply requires --confirm.' };
  return { ok: true, command: command as CliFixCommandV2 };
}

function selectSuggestion(
  id: string | undefined,
  catalogue: readonly FixSuggestionFactV1[],
): Readonly<{ ok: true; suggestion: FixSuggestionFactV1 }> | Readonly<{ ok: false; message: string }> {
  if (id !== undefined) {
    const matches = catalogue.filter((entry) => entry.id === id);
    if (matches.length === 1) return { ok: true, suggestion: matches[0]! };
    return { ok: false, message: matches.length === 0 ? 'The selected fix is not available.' : 'The selected fix is ambiguous.' };
  }
  if (catalogue.length === 1) return { ok: true, suggestion: catalogue[0]! };
  return { ok: false, message: catalogue.length === 0 ? 'No reviewed fix is available.' : 'Select one reviewed fix with --fix.' };
}

/**
 * `--confirm` is the explicit user confirmation for apply, and the digest binds it to the exact
 * suggestion source the user selected. Other prerequisite evidence is caller-owned; nothing is
 * inferred from a finding.
 */
function prerequisiteEvidence(
  declared: readonly FixPrerequisiteEvidenceV1[],
  command: CliFixCommandV2,
  suggestion: FixSuggestionFactV1,
): readonly FixPrerequisiteEvidenceV1[] {
  const evidence = new Map(declared.map((entry) => [entry.code, entry] as const));
  if (command.action === 'apply' && command.confirm && !evidence.has('USER_CONFIRMATION')) {
    evidence.set('USER_CONFIRMATION', Object.freeze({ code: 'USER_CONFIRMATION', evidenceDigest: suggestion.sourceSha256 }));
  }
  return Object.freeze([...evidence.values()]);
}

function document(
  action: FixCommandDocumentV2['action'],
  fields: Omit<FixCommandDocumentV2, 'schemaVersion' | 'action'>,
): FixCommandDocumentV2 {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, action, ...fields });
}

function emit(exitCode: FixCommandExitCodeV2, emitted: FixCommandDocumentV2, message?: string): FixCommandResultV2 {
  return Object.freeze({
    exitCode,
    stdout: `${JSON.stringify(emitted)}\n`,
    stderr: message === undefined ? '' : `${message}\n`,
    document: emitted,
  });
}

function failed(
  action: FixCommandDocumentV2['action'],
  code: string,
  message: string,
  exitCode: FixCommandExitCodeV2,
  suggestion?: FixSuggestionFactV1,
  planFields?: Readonly<Pick<FixCommandDocumentV2, 'plan' | 'prerequisites'>>,
): FixCommandResultV2 {
  const fields: Omit<FixCommandDocumentV2, 'schemaVersion' | 'action'> = {
    status: 'FAILED',
    code,
    message,
    ...(suggestion === undefined ? {} : { suggestionId: suggestion.id, suggestion }),
    ...(planFields ?? {}),
  };
  return emit(exitCode, document(action, fields), `Fix ${action} FAILED (${code}): ${message}`);
}

function cancelled(action: 'suggest' | 'apply'): FixCommandResultV2 {
  return emit(130, document(action, { status: 'CANCELLED', reason: 'CANCELLED' }));
}
