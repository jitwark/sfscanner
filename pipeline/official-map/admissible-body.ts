import { readFileSync } from 'node:fs';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

/**
 * Which local body files the pipeline is allowed to read, and why the rest are
 * not.
 *
 * A body is the raw n8n workflow JSON as the template author exported it. The
 * `01_deduplicated_master/` folder holds legacy copies of the same bodies with
 * two extra top-level blocks bolted on — `_security`
 * ("Phase2-DualEngine-v2") and `_documentation` ("gemini-3.1-flash-lite") —
 * which are pre-computed model-written prose and superseded security verdicts.
 * `community-hub/AGENTS.md` rule 8 forbids publishing model-written claims, and
 * `openspec/config.yaml` says provenance is acquired, never inferred, so a body
 * carrying them has unestablished provenance and cannot be used. It is refused,
 * never stripped: stripping would hide the population it affects.
 *
 * See `docs/superpowers/plans/2026-09-28-official-body-coverage.md` §Task 1.2.
 */

/**
 * The top-level keys a real curated n8n export carries, measured 2026-09-28
 * across all 9,564 `official__<templateId>_<slug>.json` files in
 * `04_curated_official_and_github/official/` — the folder the pipeline has
 * always bound, and the only one curation has already vetted — plus three newer
 * upstream fields admitted by owner directive after measuring them across both
 * bound folders (`canExecute` and `parentFolderId` on 2 bodies each, `_fileName`
 * on 1; see `docs/audit/2026-09-28-body-coverage/refused-bodies-evidence.md`).
 * The union, not a guess, because the shape is wide: 19 of the original 26 keys
 * appear in fewer than 6,200 of the files, and a five-key list (`id`, `name`,
 * `nodes`, `connections`, `settings`) would have refused the 8,730 bodies
 * carrying `pinData` alone. Anything outside this allowlist is an injected annotation.
 */
export const AUTHENTIC_BODY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  _fileName: true,
  _meta: true,
  active: true,
  activeVersion: true,
  activeVersionId: true,
  canExecute: true,
  connections: true,
  createdAt: true,
  description: true,
  id: true,
  isArchived: true,
  meta: true,
  name: true,
  nodeGroups: true,
  nodes: true,
  notes: true,
  parentFolderId: true,
  pinData: true,
  scopes: true,
  settings: true,
  shared: true,
  staticData: true,
  tags: true,
  triggerCount: true,
  updatedAt: true,
  version: true,
  versionCounter: true,
  versionId: true,
  versionMetadata: true,
} as const);

/**
 * The `offendingKeys` entry reported for a file that is not a workflow object
 * at all: an array, a scalar, or bytes that are not JSON. Reading a body that
 * is not a body is a finding, so it is named rather than folded into "no body".
 */
export const NOT_A_WORKFLOW_BODY = '<not-a-workflow-body>';

export type BodyClassification =
  | { kind: 'authentic' }
  | { kind: 'annotated'; offendingKeys: string[] };

/** A parsed body that is a workflow object at all, as opposed to an array or a scalar. */
export function isWorkflowBody(parsed: unknown): parsed is Record<string, unknown> {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

export function classifyOfficialBody(parsed: unknown): BodyClassification {
  if (!isWorkflowBody(parsed)) {
    return { kind: 'annotated', offendingKeys: [NOT_A_WORKFLOW_BODY] };
  }
  const offendingKeys = Object.keys(parsed)
    .filter((key) => !Object.hasOwn(AUTHENTIC_BODY_KEYS, key))
    .sort(compareCanonicalStrings);
  return offendingKeys.length === 0 ? { kind: 'authentic' } : { kind: 'annotated', offendingKeys };
}

/**
 * A body with every annotation removed, and the names of what was removed. The
 * two travel together so a caller cannot strip a body without being able to say
 * what it stripped: the removal is the finding, not an implementation detail.
 */
export type StrippedOfficialBody = {
  /** A new object. The annotated input is left as it was. */
  body: Record<string, unknown>;
  /** Canonically ordered; empty when the body carried no annotation. */
  removedKeys: string[];
};

/**
 * Remove every top-level key outside the authentic allowlist. Only meaningful for
 * a body that is a workflow object at all, so anything else is refused loudly
 * rather than being quietly passed through — use `classifyOfficialBody` first.
 *
 * Trimming hides the annotations it removes, so it is only ever reached behind
 * the equivalence proof in `trim-equivalence-proof.ts`; see that module for why
 * the proof has to pass before this may run.
 */
export function stripAnnotations(parsed: unknown): StrippedOfficialBody {
  if (!isWorkflowBody(parsed)) {
    throw new Error(`cannot strip annotations from ${NOT_A_WORKFLOW_BODY}`);
  }
  const body: Record<string, unknown> = {};
  const removedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.hasOwn(AUTHENTIC_BODY_KEYS, key)) body[key] = value;
    else removedKeys.push(key);
  }
  return { body, removedKeys: removedKeys.sort(compareCanonicalStrings) };
}

/**
 * The parsed body, or `undefined` when the file cannot be read or is not JSON.
 * `undefined` is not a body — no JSON document parses to it — so a caller can
 * tell "unreadable" from "readable" without a second read or a caught throw.
 */
export function readOfficialBody(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Classify one body file. An unreadable file is refused with the sentinel key
 * rather than being reported as "no body here": the two are different facts,
 * and only one of them means the entry's body is missing.
 */
export function readOfficialBodyVerdict(file: string): BodyClassification {
  return classifyOfficialBody(readOfficialBody(file));
}
