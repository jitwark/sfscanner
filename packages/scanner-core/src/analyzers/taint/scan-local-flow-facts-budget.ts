import { FIELD_FLOW_ENUMS_V1 } from '@hub/contracts/scanner-v2-field-flow';
import { SCAN_LOCAL_LIMITS_V1 } from './scan-local-state';
import type { ScanLocalFlowFactsInputV1 } from './scan-local-flow-facts';

/** Worst case for one UTF-16 unit through JSON escaping, UTF-8 framing and identity encoding. */
const WIRE_UNITS_PER_CODE_UNIT = 6;
/** Guards, freeze and the canonical envelope around both identity hashes. */
const FIXED_FACT_UNITS = 16;
const MAX_SEGMENTS = SCAN_LOCAL_LIMITS_V1.maxPathDepth;
const MAX_LABELS = FIELD_FLOW_ENUMS_V1.fieldFlowLabel.length;
/**
 * The validator reads every occurrence slot through own-index enumeration, name validation and a
 * mapped copy, so one unit per slot would underpay the traversal that `readSubject` performs.
 */
const OCCURRENCE_SLOT_UNITS = 3;

function textUnits(value: unknown): number {
  return typeof value === 'string' ? 1 + WIRE_UNITS_PER_CODE_UNIT * value.length : 1;
}

/** Bounded scalar/array-length read: every slot the contract readers walk is paid for, plus items. */
function listUnits(values: unknown, maximum: number, each: (item: unknown) => number): number {
  if (!Array.isArray(values)) return 1;
  const length = values.length;
  const inspected = Math.min(length, maximum + 1);
  let units = 1 + length;
  for (let index = 0; index < inspected; index += 1) units += each(values[index]);
  return units;
}

function occurrenceUnits(values: unknown): number {
  if (!Array.isArray(values)) return 1;
  const length = values.length;
  const inspected = Math.min(length, MAX_SEGMENTS + 1);
  let units = 1 + length * OCCURRENCE_SLOT_UNITS;
  for (let index = 0; index < inspected; index += 1) units += textUnits(values[index]);
  return units;
}

/** The emitter inspects at most the reason cap plus one entry; the rest is only counted as overflow. */
function reasonUnits(values: unknown): number {
  if (!Array.isArray(values)) return 1;
  const inspected = Math.min(values.length, SCAN_LOCAL_LIMITS_V1.maxUnknownReasons + 1);
  let units = 1 + inspected;
  for (let index = 0; index < inspected; index += 1) units += textUnits(values[index]);
  return units;
}

function atomUnits(atom: unknown): number {
  if (atom === null || typeof atom !== 'object') return 1;
  const value = atom as Record<string, unknown>;
  return 3 + textUnits(value.sourceId) + textUnits(value.channel) + listUnits(value.field, MAX_SEGMENTS, textUnits);
}

function tokenUnits(token: unknown): number {
  if (token === null || typeof token !== 'object') return 1;
  const value = token as Record<string, unknown>;
  return 2 + textUnits(value.modelId) + textUnits(value.sink) + textUnits(value.pathDigest);
}

function subjectUnits(subject: unknown): number {
  if (subject === null || typeof subject !== 'object') return FIXED_FACT_UNITS;
  const value = subject as Record<string, unknown>;
  if (value.kind !== 'NODE' || value.node === null || typeof value.node !== 'object') return FIXED_FACT_UNITS;
  const node = value.node as Record<string, unknown>;
  let units = FIXED_FACT_UNITS + textUnits(node.identityDigest) + textUnits(node.explicitId) + textUnits(node.name);
  if (node.source !== null && typeof node.source === 'object') {
    const source = node.source as Record<string, unknown>;
    units += textUnits(source.pointer) + textUnits(source.astNodeId) + occurrenceUnits(source.occurrencePath);
  }
  return units;
}

/** Conservative dynamic cost of this exact flow: no maximum payload is reserved for a small one. */
export function prepaidUnits(input: ScanLocalFlowFactsInputV1): number {
  const { candidate } = input;
  return FIXED_FACT_UNITS + subjectUnits(input.sourceSubject) + subjectUnits(input.sinkSubject)
    + listUnits(candidate.atom.field, MAX_SEGMENTS, textUnits) + listUnits(input.sinkFieldPath, MAX_SEGMENTS, textUnits)
    + listUnits(input.taintLabels, MAX_LABELS, textUnits)
    + textUnits(input.sinkClass) + textUnits(input.sinkParameterPath) + textUnits(input.sinkChannel)
    + textUnits(input.edgeChannel) + textUnits(input.propertyPath)
    + atomUnits(candidate.atom) + listUnits(candidate.sinkState.atoms, SCAN_LOCAL_LIMITS_V1.maxAtomsPerField, atomUnits)
    + listUnits(candidate.sinkState.sanitizedFor, SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens, tokenUnits)
    + reasonUnits(candidate.sinkState.unknownReasons);
}

/** An over-cap sink path can never become a property, so it is refused before any digest or debit. */
export function exceedsSinkPathCap(value: unknown): boolean {
  return !Array.isArray(value) || value.length > MAX_SEGMENTS;
}
