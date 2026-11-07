import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { INTEGRATION_MAP } from '../enrich/integration-map.js';
import { integrationLabelForNodeType } from './structure.js';

/**
 * Bring an already-published integration label onto the canonical vendor
 * vocabulary, for an entry whose body is not available.
 *
 * The published catalogue carries the *pre-`679f0d0`* normaliser's output: one
 * label per node type, computed as "strip the n8n package prefix, strip a
 * trailing `Trigger`/`Node`, splat camelCase, lowercase". That vocabulary is
 * 997 labels wide and holds capability words (`code`, `http-request`,
 * `schedule`) beside vendor products, while a body derived today produces the
 * 88 canonical vendor tags. Two vocabularies in one `data/` cannot be described
 * by one facet set, so the labels have to be mapped — not guessed at.
 *
 * The map is exact because both sides are the same function of a node type:
 * this module rebuilds the legacy label for every key of `INTEGRATION_MAP` and
 * indexes by it, so a legacy label resolves to the real node type that produced
 * it and then through *the same* `integrationLabelForNodeType` a body uses.
 * A label with no map entry is dropped, exactly as an unmapped community node
 * type is dropped for a body.
 */

/**
 * The pre-`679f0d0` `integration()` verbatim. Kept as its own function, and
 * stated as history, because it is the *inverse* this module needs: changing it
 * to match today's rule would silently stop finding the labels it exists to map.
 */
export function legacyIntegrationLabel(nodeType: string): string {
  const clean = nodeType
    .replace(/^n8n-nodes-base\./, '')
    .replace(/^@n8n\/n8n-nodes-langchain\./, '');
  return clean
    .replace(/Trigger$/, '')
    .replace(/Node$/, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Legacy label -> the integration-map keys that produce it, in canonical order. */
const KEYS_BY_LEGACY_LABEL: ReadonlyMap<string, readonly string[]> = (() => {
  const grouped = new Map<string, string[]>();
  for (const key of [...Object.keys(INTEGRATION_MAP)].sort(compareCanonicalStrings)) {
    const label = legacyIntegrationLabel(key);
    const existing = grouped.get(label);
    if (existing) existing.push(key);
    else grouped.set(label, [key]);
  }
  return grouped;
})();

/**
 * The canonical vendor tag a published legacy label stands for, or `null` when
 * the label names no mapped integration (a capability word, or a community
 * package n8n's node-type map does not describe).
 *
 * A legacy label can name more than one map key — `googleSheets` and
 * `googleSheetsTrigger` both collapse to `google-sheets`. The first key in
 * canonical string order that yields a vendor tag decides, so the result does
 * not depend on the integration map's insertion order.
 */
export function canonicalIntegrationLabel(legacyLabel: string): string | null {
  for (const key of KEYS_BY_LEGACY_LABEL.get(legacyLabel.trim().toLowerCase()) ?? []) {
    const tag = integrationLabelForNodeType(key);
    if (tag) return tag;
  }
  return null;
}

/**
 * The canonical integration list for an entry with no body: every published
 * label mapped, unmappable labels dropped, deduped and sorted exactly the way
 * `deriveStructure` sorts a body-derived list.
 */
export function normalizeIntegrationLabels(labels: readonly string[]): string[] {
  const canonical = new Set<string>();
  for (const label of labels) {
    const tag = canonicalIntegrationLabel(label);
    if (tag) canonical.add(tag);
  }
  return [...canonical].sort(compareCanonicalStrings);
}
