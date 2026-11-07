import { SECRET_PATTERNS } from './secret-patterns.js';

export type VerifyResult = {
  ok: boolean;
  errors: string[];
};

const CODE_NODE_TYPES: Record<string, true> = {
  'n8n-nodes-base.code': true,
  'n8n-nodes-base.function': true,
  'n8n-nodes-base.functionItem': true,
};

const CODE_PARAM_KEYS: Record<string, true> = {
  jsCode: true,
  pythonCode: true,
  functionCode: true,
  functionItemCode: true,
  code: true,
};

export function verifySanitizedWorkflow(originalJson: unknown, sanitizedJson: unknown): VerifyResult {
  const errors: string[] = [];

  if (!sanitizedJson || typeof sanitizedJson !== 'object') {
    return { ok: false, errors: ['Sanitized workflow is not a valid object'] };
  }

  const sWf = sanitizedJson as Record<string, unknown>;
  const oWf = (originalJson && typeof originalJson === 'object' ? originalJson : {}) as Record<string, unknown>;

  if (!Array.isArray(sWf.nodes)) {
    return { ok: false, errors: ['Sanitized workflow missing nodes array'] };
  }

  const rootResidue = ['meta', 'pinData', 'binary', 'executionId', 'instanceId', 'versionId'];
  for (const field of rootResidue) {
    if (field in sWf && sWf[field] !== undefined && sWf[field] !== null) {
      errors.push(`Residue root field '${field}' still present`);
    }
  }

  const oNodes = Array.isArray(oWf.nodes) ? oWf.nodes : [];
  const sNodes = sWf.nodes as Array<Record<string, unknown>>;

  if (oNodes.length !== sNodes.length) {
    errors.push(`Node count mismatch: original=${oNodes.length}, sanitized=${sNodes.length}`);
  } else {
    for (let i = 0; i < oNodes.length; i++) {
      const oNode = (oNodes[i] ?? {}) as Record<string, unknown>;
      const sNode = sNodes[i] ?? {};

      const oId = String(oNode.id ?? oNode.name ?? i);
      const sId = String(sNode.id ?? sNode.name ?? i);
      if (oId !== sId) {
        errors.push(`Node ID mismatch at index ${i}: original=${oId}, sanitized=${sId}`);
      }

      if (oNode.type !== sNode.type) {
        errors.push(`Node type mismatch at index ${i}: original=${oNode.type}, sanitized=${sNode.type}`);
      }
    }
  }

  const oConnStr = JSON.stringify(oWf.connections ?? {});
  const sConnStr = JSON.stringify(sWf.connections ?? {});
  if (oConnStr !== sConnStr) {
    errors.push('Connections topology changed between original and sanitized workflow');
  }

  for (let i = 0; i < sNodes.length; i++) {
    const node = sNodes[i];
    if (!node || typeof node !== 'object') continue;
    const nodePath = `nodes[${i}]`;

    for (const field of rootResidue) {
      if (field in node && node[field] !== undefined && node[field] !== null) {
        errors.push(`Residue field '${field}' present on node ${nodePath}`);
      }
    }

    if ('credentials' in node && node.credentials) {
      if (typeof node.credentials === 'object') {
        const credStr = JSON.stringify(node.credentials);
        for (const pat of SECRET_PATTERNS) {
          if (pat.pattern.test(credStr)) {
            errors.push(`Unredacted secret in credentials on node ${nodePath}`);
            break;
          }
        }
      }
    }

    const isCodeNode = typeof node.type === 'string' && Boolean(CODE_NODE_TYPES[node.type]);
    if (node.parameters && typeof node.parameters === 'object') {
      verifyParams(node.parameters, `${nodePath}.parameters`, isCodeNode, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function verifyParams(
  target: unknown,
  currentPath: string,
  isCodeNode: boolean,
  errors: string[],
): void {
  if (!target || typeof target !== 'object') return;

  if (Array.isArray(target)) {
    for (let idx = 0; idx < target.length; idx++) {
      const itemPath = `${currentPath}[${idx}]`;
      const item = target[idx];
      if (typeof item === 'string') {
        checkStringSecret('', item, itemPath, errors);
      } else if (item && typeof item === 'object') {
        verifyParams(item, itemPath, isCodeNode, errors);
      }
    }
    return;
  }

  const obj = target as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (isCodeNode && CODE_PARAM_KEYS[key]) {
      errors.push(`Executable code body present at ${currentPath}.${key}`);
      continue;
    }

    const val = obj[key];
    const keyPath = `${currentPath}.${key}`;

    if (typeof val === 'string') {
      checkStringSecret(key, val, keyPath, errors, obj);
    } else if (val && typeof val === 'object') {
      verifyParams(val, keyPath, isCodeNode, errors);
    }
  }
}

function checkStringSecret(
  key: string,
  val: string,
  path: string,
  errors: string[],
  parentObj?: Record<string, unknown>,
): void {
  const isAuthHeader =
    key.toLowerCase() === 'authorization' ||
    (parentObj &&
      typeof parentObj.name === 'string' &&
      parentObj.name.toLowerCase() === 'authorization' &&
      key === 'value');

  if (isAuthHeader && !val.includes('<redacted:')) {
    errors.push(`Unredacted Authorization header at ${path}`);
    return;
  }

  for (const pat of SECRET_PATTERNS) {
    if (pat.keyPattern) {
      if (pat.keyPattern.test(key) && pat.pattern.test(val)) {
        errors.push(`Unredacted secret (${pat.name}) at ${path}`);
        return;
      }
    } else if (pat.pattern.test(val)) {
      errors.push(`Unredacted secret (${pat.name}) at ${path}`);
      return;
    }
  }
}
