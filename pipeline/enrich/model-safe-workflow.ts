import { SECRET_PATTERNS } from '../sanitize/secret-patterns';

export type ModelInputAudit = { ok: boolean; errors: string[] };

const ROOT_DROP_KEYS = new Set([
  'id', 'name', 'description', 'summary', 'meta', 'source', 'rights', 'permalink',
  'fetchedAt', 'upstreamDescription', 'descriptionProvenance', 'generatedAt',
  'promptVersion', 'pinData', 'binary', 'staticData', 'executionId', 'instanceId',
  'versionId', 'tags',
]);

const DROP_KEYS = new Set([
  // These are implementation identifiers, not workflow behaviour. Keeping
  // them gives the secret auditor a large false-positive surface (for example
  // an n8n node id can look exactly like an AC... Twilio token) while adding no
  // useful context for a layperson-facing description.
  'id', 'webhookId', 'nodeId', 'workflowId', 'credentialId',
  'credentials', 'pinData', 'binary', 'executionId', 'instanceId', 'versionId',
  'jsCode', 'pythonCode', 'functionCode', 'functionItemCode', 'code',
  'source', 'rights', 'permalink', 'fetchedAt', 'upstreamDescription',
  'descriptionProvenance', 'promptVersion', 'generatedAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAuthKey(key: string, parent?: Record<string, unknown>): boolean {
  return key.toLowerCase() === 'authorization' ||
    (typeof parent?.name === 'string' && parent.name.toLowerCase() === 'authorization' && key === 'value');
}

function isSensitiveKey(key: string, parent?: Record<string, unknown>): boolean {
  return isAuthKey(key, parent) || /^(?:api[_-]?key|secret|password|passwd|pass|token|bearer|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|webhook[_-]?secret)$/i.test(key);
}

function hasSecret(key: string, value: string, parent?: Record<string, unknown>): boolean {
  if (value.startsWith('<redacted')) return false;
  if (isSensitiveKey(key, parent)) return true;
  return SECRET_PATTERNS.some((definition) => {
    if (definition.keyPattern) return definition.keyPattern.test(key) && definition.pattern.test(value);
    return definition.pattern.test(value);
  });
}

function projectValue(value: unknown, parentKey: string | undefined, atRoot: boolean, parent?: Record<string, unknown>): unknown {
  if (typeof value === 'string') return parentKey && hasSecret(parentKey, value, parent) ? '<redacted>' : value;
  if (Array.isArray(value)) return value.map((item) => projectValue(item, parentKey, false, parent));
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((atRoot && ROOT_DROP_KEYS.has(key)) || DROP_KEYS.has(key)) continue;
    if (isSensitiveKey(key, value)) {
      result[key] = '<redacted>';
      continue;
    }
    result[key] = projectValue(child, key, false, value);
  }
  return result;
}

/**
 * Projects an n8n workflow into the only model input permitted by the recovery
 * process. The projection intentionally removes provenance, titles, credentials,
 * sample payloads, and executable code before the packet is written to disk.
 */
export function projectWorkflowForGemini(workflow: unknown): unknown {
  return projectValue(workflow, undefined, true);
}

/**
 * Removes free-form parameter text while retaining the graph vocabulary. This
 * is a second, policy-safe projection used only when the provider refuses the
 * normal workflow JSON; it still contains workflow JSON and never catalogue prose.
 */
export function projectWorkflowForGeminiRestricted(workflow: unknown): unknown {
  const keep = (value: unknown, key?: string, atRoot = false): unknown => {
    if (typeof value === 'string') return key === 'name' || key === 'type' || key === 'node' ? value : undefined;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.map((item) => keep(item, key)).filter((item) => item !== undefined);
    if (!isRecord(value)) return undefined;
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      if ((atRoot && ROOT_DROP_KEYS.has(childKey)) || DROP_KEYS.has(childKey) || isSensitiveKey(childKey, value)) continue;
      const projected = keep(child, childKey);
      if (projected !== undefined) result[childKey] = projected;
    }
    return result;
  };
  return keep(workflow, undefined, true);
}

function auditValue(
  value: unknown,
  path: string,
  atRoot: boolean,
  errors: string[],
  parent?: Record<string, unknown>,
  key?: string,
): void {
  if (typeof value === 'string') {
    // Apply key-scoped patterns with the key context. The generic 32-character
    // pattern is intentionally not a global substring detector: workflow type
    // names, paths, and provider resource IDs routinely look like that shape.
    if (key && hasSecret(key, value, parent)) {
      errors.push(`${path}: secret-like value present`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditValue(item, `${path}[${index}]`, false, errors, parent, key));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if ((atRoot && ROOT_DROP_KEYS.has(key)) || DROP_KEYS.has(key)) {
      errors.push(`${path}.${key}: prohibited field present`);
      continue;
    }
    if (isSensitiveKey(key, value) && !(typeof child === 'string' && child.startsWith('<redacted'))) {
      errors.push(`${path}.${key}: sensitive value must be redacted`);
      continue;
    }
    auditValue(child, `${path}.${key}`, false, errors, value, key);
  }
}

export function auditGeminiWorkflowInput(workflows: unknown[], forbiddenText: string[] = []): ModelInputAudit {
  const errors: string[] = [];
  if (!Array.isArray(workflows)) return { ok: false, errors: ['packet must be an array'] };
  workflows.forEach((workflow, index) => {
    if (!isRecord(workflow)) {
      errors.push(`workflows[${index}]: workflow must be an object`);
      return;
    }
    if (!Array.isArray(workflow.nodes)) errors.push(`workflows[${index}].nodes: missing nodes array`);
    if (!isRecord(workflow.connections)) errors.push(`workflows[${index}].connections: missing connections object`);
    auditValue(workflow, `workflows[${index}]`, true, errors);
  });
  const serialized = JSON.stringify(workflows);
  for (const text of forbiddenText) {
    const trimmed = text.trim();
    const words = trimmed.split(/\s+/u).filter(Boolean);
    // A one-word catalogue label can legitimately be repeated by a workflow
    // node or message. Only compare substantial prose, not short labels.
    if (trimmed.length >= 24 && words.length >= 4 && serialized.includes(trimmed)) {
      errors.push('packet contains forbidden source prose');
    }
  }
  return { ok: errors.length === 0, errors };
}
