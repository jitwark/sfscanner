import { SECRET_PATTERNS } from './secret-patterns.js';
import { removeCodeParameter } from './code-bodies.js';
import { hashValue } from './value-hash.js';

export type RedactManifestEntry = {
  path: string;
  rule: string;
  beforeSha256: string;
  after: unknown;
};

export type RedactResult = {
  workflow: unknown;
  manifest: RedactManifestEntry[];
  ok: boolean;
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

function getPlaceholder(patternName: string): string {
  if (patternName === 'basic_auth_url') return '<redacted:basic-auth-url>';
  if (patternName === 'jwt_token') return '<redacted:jwt-token>';
  if (patternName === 'bearer_token') return '<redacted:bearer-token>';
  return '<redacted:api-key>';
}

export function sanitizeWorkflow(json: unknown): RedactResult {
  if (!json || typeof json !== 'object') {
    return { workflow: json, manifest: [], ok: false };
  }

  const manifest: RedactManifestEntry[] = [];
  const wf = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;

  const rootFields: Array<{ key: string; rule: string }> = [
    { key: 'meta', rule: 'workflow_metadata' },
    { key: 'pinData', rule: 'pin_data' },
    { key: 'binary', rule: 'binary_data' },
    { key: 'executionId', rule: 'execution_id' },
    { key: 'instanceId', rule: 'instance_id' },
    { key: 'versionId', rule: 'version_id' },
  ];

  for (const { key, rule } of rootFields) {
    if (key in wf && wf[key] !== undefined) {
      manifest.push({
        path: key,
        rule,
        beforeSha256: hashValue(wf[key]),
        after: null,
      });
      delete wf[key];
    }
  }

  if (Array.isArray(wf.nodes)) {
    for (let i = 0; i < wf.nodes.length; i++) {
      const node = wf.nodes[i];
      if (!node || typeof node !== 'object') continue;
      const nodePath = `nodes[${i}]`;

      for (const { key, rule } of rootFields) {
        if (key in node && node[key] !== undefined) {
          manifest.push({
            path: `${nodePath}.${key}`,
            rule,
            beforeSha256: hashValue(node[key]),
            after: null,
          });
          delete node[key];
        }
      }

      if ('credentials' in node && node.credentials) {
        manifest.push({
          path: `${nodePath}.credentials`,
          rule: 'node_credentials',
          beforeSha256: hashValue(node.credentials),
          after: '<redacted:credentials>',
        });
        node.credentials = '<redacted:credentials>';
      }

      const isCodeNode = typeof node.type === 'string' && Boolean(CODE_NODE_TYPES[node.type]);
      if (node.parameters && typeof node.parameters === 'object') {
        sanitizeParams(node.parameters, `${nodePath}.parameters`, isCodeNode, manifest);
      }
    }
  }

  return { workflow: wf, manifest, ok: true };
}

function sanitizeParams(
  target: unknown,
  currentPath: string,
  isCodeNode: boolean,
  manifest: RedactManifestEntry[],
): void {
  if (!target || typeof target !== 'object') return;

  if (Array.isArray(target)) {
    for (let idx = 0; idx < target.length; idx++) {
      const itemPath = `${currentPath}[${idx}]`;
      const item = target[idx];
      if (typeof item === 'string') {
        const replacement = checkSecretString('', item);
        if (replacement) {
          manifest.push({
            path: itemPath,
            rule: replacement.rule,
            beforeSha256: hashValue(item),
            after: replacement.placeholder,
          });
          target[idx] = replacement.placeholder;
        }
      } else if (item && typeof item === 'object') {
        sanitizeParams(item, itemPath, isCodeNode, manifest);
      }
    }
    return;
  }

  const obj = target as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (CODE_PARAM_KEYS[key]) {
      removeCodeParameter(obj, key, `${currentPath}.${key}`, manifest);
      continue;
    }
    // Type-agnostic catch: code bodies smuggled into non-Code node types
    // (measured: noOp nodes carrying jsCode or a code.execute object).
    // A 'code' key holding an n8n expression string is a data column and stays.
    if (key === 'code') {
      const val = obj[key];
      const looksLikeBody =
        (val && typeof val === 'object') ||
        (typeof val === 'string' && val.length > 0 && !val.startsWith('='));
      if (looksLikeBody) {
        removeCodeParameter(obj, key, `${currentPath}.${key}`, manifest);
        continue;
      }
    }

    const val = obj[key];
    const keyPath = `${currentPath}.${key}`;

    if (typeof val === 'string') {
      const replacement = checkSecretString(key, val, obj);
      if (replacement) {
        manifest.push({
          path: keyPath,
          rule: replacement.rule,
          beforeSha256: hashValue(val),
          after: replacement.placeholder,
        });
        obj[key] = replacement.placeholder;
      }
    } else if (val && typeof val === 'object') {
      sanitizeParams(val, keyPath, isCodeNode, manifest);
    }
  }
}

function checkSecretString(
  key: string,
  val: string,
  parentObj?: Record<string, unknown>,
): { rule: string; placeholder: string } | null {
  const isAuthHeader =
    key.toLowerCase() === 'authorization' ||
    (parentObj &&
      typeof parentObj.name === 'string' &&
      parentObj.name.toLowerCase() === 'authorization' &&
      key === 'value');

  if (isAuthHeader) {
    return { rule: 'authorization_header', placeholder: '<redacted:authorization-header>' };
  }

  for (const pat of SECRET_PATTERNS) {
    if (pat.keyPattern) {
      if (pat.keyPattern.test(key) && pat.pattern.test(val)) {
        return { rule: `secret_pattern:${pat.name}`, placeholder: '<redacted:api-key>' };
      }
    } else if (pat.pattern.test(val)) {
      return { rule: `secret_pattern:${pat.name}`, placeholder: getPlaceholder(pat.name) };
    }
  }

  return null;
}
