import { LIMITS } from '@hub/contracts';
import type { DynamicHost, HostnameExtraction } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

// The shapes live in @hub/contracts because `Entry` carries them; this module
// re-exports them so callers importing the deriver get its types too.
export type { DynamicHost, HostnameExtraction } from '@hub/contracts';

// Defensive bounds: this reads untrusted, possibly adversarial workflow JSON.
const MAX_NODES = LIMITS.maxNodes;
const MAX_DEPTH = 6;
const MAX_KEYS_PER_OBJECT = 200;
const MAX_ITEMS_PER_ARRAY = 200;
const MAX_CANDIDATES = 5_000;
const MAX_STRING_LENGTH = 4_096;

// n8n's markers for an expression-driven value: `={{ ... }}`, `{{ $json.x }}`, `$node['x']`.
const EXPRESSION_PATTERN = /\{\{|\$node\[|\$json/;
// Parameter names that plausibly carry a URL even without a literal `://` yet
// (e.g. a fully templated `={{ $json.endpoint }}`). Kept narrow to avoid treating
// every expression-bearing field (channel names, messages, …) as a URL candidate.
const URL_KEY_PATTERN = /url|uri|endpoint/i;

type Candidate = { key: string; value: string };
type ClassifyResult =
  | { kind: 'literal'; host: string }
  | { kind: 'dynamic'; host: string }
  | { kind: 'undeterminable' }
  | { kind: 'skip' };

function nodesOf(workflow: unknown): Record<string, unknown>[] {
  if (!workflow || typeof workflow !== 'object' || !('nodes' in workflow)) return [];
  const value = (workflow as Record<string, unknown>).nodes;
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_NODES)
    .filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object' && !Array.isArray(node)));
}

function walkParameters(value: unknown, key: string, depth: number, out: Candidate[]): void {
  if (out.length >= MAX_CANDIDATES) return;
  if (typeof value === 'string') {
    out.push({ key, value });
    return;
  }
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ITEMS_PER_ARRAY)) {
      if (out.length >= MAX_CANDIDATES) return;
      walkParameters(item, key, depth + 1, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS_PER_OBJECT)) {
      if (out.length >= MAX_CANDIDATES) return;
      walkParameters(childValue, childKey, depth + 1, out);
    }
  }
}

function collectCandidateStrings(node: Record<string, unknown>): Candidate[] {
  const parameters = node.parameters;
  if (!parameters || typeof parameters !== 'object') return [];
  const out: Candidate[] = [];
  walkParameters(parameters, '', 0, out);
  return out;
}

function isUrlCandidate(key: string, value: string): boolean {
  if (value.includes('://')) return true;
  return URL_KEY_PATTERN.test(key) && EXPRESSION_PATTERN.test(value);
}

/** Strips a trailing dot (FQDN notation) and normalizes case. `new URL()` already lowercases. */
function normalizeHost(host: string): string {
  return host.replace(/\.+$/, '');
}

function parseLiteralHost(candidateUrl: string): string | null {
  try {
    const url = new URL(candidateUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = normalizeHost(url.hostname);
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function authorityOf(rest: string): string {
  const match = rest.match(/[/?#\s]/);
  return match && typeof match.index === 'number' ? rest.slice(0, match.index) : rest;
}

function classifyUrl(raw: string): ClassifyResult {
  const text = raw.length > MAX_STRING_LENGTH ? raw.slice(0, MAX_STRING_LENGTH) : raw;
  const stripped = text.startsWith('=') ? text.slice(1) : text;

  if (!EXPRESSION_PATTERN.test(stripped)) {
    const host = parseLiteralHost(stripped);
    return host ? { kind: 'literal', host } : { kind: 'skip' };
  }

  const schemeIndex = stripped.indexOf('://');
  if (schemeIndex === -1) return { kind: 'undeterminable' };

  const authority = authorityOf(stripped.slice(schemeIndex + 3));
  // Host segment itself carries the template: cannot be known without guessing.
  if (/[{}$]/.test(authority)) return { kind: 'undeterminable' };

  const host = parseLiteralHost(`http://${authority}`);
  return host ? { kind: 'dynamic', host } : { kind: 'undeterminable' };
}

/**
 * Extracts the hostnames a workflow actually talks to from URL-shaped parameter
 * values (httpRequest URLs, webhook tool endpoints, etc.), separately from the
 * node-type-derived integration list. Never emits path, query, or credentials —
 * only `URL.hostname`, so query secrets and userinfo tricks never surface.
 *
 * Pure and bounded: caps node count, object depth/breadth, array length, string
 * length, and total candidates so hostile input cannot make this unbounded work.
 */
export function deriveHostnames(workflow: unknown): HostnameExtraction {
  const literal = new Set<string>();
  const dynamic = new Set<string>();
  let undeterminable = 0;

  for (const node of nodesOf(workflow)) {
    for (const { key, value } of collectCandidateStrings(node)) {
      if (!isUrlCandidate(key, value)) continue;
      const result = classifyUrl(value);
      if (result.kind === 'literal') literal.add(result.host);
      else if (result.kind === 'dynamic') dynamic.add(result.host);
      else if (result.kind === 'undeterminable') undeterminable += 1;
    }
  }

  return {
    literal: [...literal].sort(compareCanonicalStrings),
    dynamic: [...dynamic].sort(compareCanonicalStrings).map((host) => ({ host })),
    undeterminable,
  };
}
