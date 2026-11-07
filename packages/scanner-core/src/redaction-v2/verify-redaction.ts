// DEVELOPMENT-ONLY / UNWIRED: no production caller and not exported from @hub/scanner-core (P1-4
// unclaim 2026-09-17; reconfirmed by task 5.2a on 2026-09-24, which removed every shipped claim of
// this capability). Do not cite as a shipped guarantee, and do not wire it without a v2-admission
// decision. Successor owner: scanner maintainer (Phase 5 track t1) —
// docs/audit/2026-09-16-fix/PHASE1-LEDGER.md.
import { hasResidualSecret, applyRedactionPatches, type RedactionPatchV2, type RedactionError } from './patches';

export type RedactionVerificationInput = Readonly<{ original: string; artifact: string; patches: readonly RedactionPatchV2[]; reparse?: (text: string) => boolean; rescan?: (text: string) => boolean; residual?: (text: string) => boolean }>;
export type RedactionVerification = Readonly<{ ok: true; reparsed: true; rescanned: true; idempotent: true; residualCanariesPassed: true }> | Readonly<{ ok: false; artifact: null; patches: readonly []; error: RedactionError }>;
const empty = Object.freeze([]) as readonly [];
const failure = (observed?: number): RedactionVerification => Object.freeze({ ok: false, artifact: null, patches: empty, error: Object.freeze({ code: 'REDACTION_VERIFICATION_FAILED', ...(observed === undefined ? {} : { observed }) }) });

export function verifyRedactionResult(input: RedactionVerificationInput): RedactionVerification {
  if (!input || typeof input.original !== 'string' || typeof input.artifact !== 'string' || !Array.isArray(input.patches)) return failure();
  const applied = applyRedactionPatches(input.original, input.patches);
  if (!applied.ok || applied.artifact !== input.artifact) return failure(input.patches.length);
  let reparsed = true;
  let rescanned = true;
  let residualCanariesPassed = !hasResidualSecret(input.original, input.artifact, input.patches);
  try {
    if (input.reparse) reparsed = input.reparse(input.artifact) === true;
    if (input.rescan) rescanned = input.rescan(input.artifact) === true;
    if (input.residual) residualCanariesPassed = residualCanariesPassed && input.residual(input.artifact) === true;
  } catch {
    return failure(input.patches.length);
  }
  if (!reparsed || !rescanned || !residualCanariesPassed || !idempotent(input.original, input.artifact, input.patches)) return failure(input.patches.length);
  return Object.freeze({ ok: true, reparsed: true, rescanned: true, idempotent: true, residualCanariesPassed: true });
}

function idempotent(original: string, artifact: string, patches: readonly RedactionPatchV2[]): boolean {
  const first = applyRedactionPatches(original, patches);
  if (!first.ok || first.artifact !== artifact) return false;
  const replay = applyRedactionPatches(artifact, patches);
  if (!replay.ok || replay.artifact !== artifact) return false;
  return !hasResidualSecret(artifact, artifact, []);
}
