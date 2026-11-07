import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_PATTERNS as SANITIZER_SECRET_PATTERNS } from './sanitize/secret-patterns.js';

export type AuditHitRule =
  | 'canary'
  | 'authorization_literal'
  | 'secret_pattern'
  | 'official_raw_signature'
  | 'forbidden_field';

export type AuditHit = {
  file: string;
  jsonPath?: string;
  rule: AuditHitRule;
  snippet: string;
};

export const CANARY_STRINGS = [
  'canaryFakeSecretKey',
  'canarySignature',
  'canaryUser',
  'canaryPass',
  'sk-proj-canary',
] as const;

export const SECRET_PATTERNS = SANITIZER_SECRET_PATTERNS
  .filter((definition) => !definition.keyPattern)
  .map((definition) => ({ name: definition.name, pattern: withTokenBoundary(definition.pattern) }));
export const AUTH_LITERAL_PATTERN = /Authorization:\s*['"]?(?:Bearer|Basic|Api-?Key|Token)\s+[A-Za-z0-9._~+\-/=]{8,}/i;

const SAFE_PLACEHOLDER_PATTERN = /(?:<redacted:|\$\{|\{\{|YOUR_[A-Z0-9_]+|REPLACE_ME)/i;

function withTokenBoundary(pattern: RegExp): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])(?:${pattern.source})`, pattern.flags);
}

function isSafePlaceholder(value: string): boolean {
  return SAFE_PLACEHOLDER_PATTERN.test(value);
}

export async function auditPrivacyFiles(filePaths: string[]): Promise<{ hits: AuditHit[]; ok: boolean }> {
  const hits: AuditHit[] = [];

  for (const filePath of filePaths) {
    let content = '';
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    for (const canary of CANARY_STRINGS) {
      if (content.includes(canary)) hits.push({ file: filePath, rule: 'canary', snippet: `Found canary string "${canary}"` });
    }

    let parsed = false;
    try {
      const parsedValue = JSON.parse(content);
      checkOfficialRawSignature(filePath, parsedValue, hits);
      checkForbiddenFields(filePath, parsedValue, hits);
      parsed = true;
    } catch {
      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (!line.trim()) return;
          try {
            const parsedValue = JSON.parse(line);
            checkOfficialRawSignature(filePath, parsedValue, hits, `line[${idx + 1}]`);
            checkForbiddenFields(filePath, parsedValue, hits, `line[${idx + 1}]`);
            parsed = true;
          } catch {
            auditUnstructuredText(filePath, line, hits);
          }
        });
      }
    }
    if (!parsed && !filePath.endsWith('.jsonl')) auditUnstructuredText(filePath, content, hits);
  }

  if (hits.length > 0) {
    console.error(`\n[PRIVACY AUDIT FAILED] Found ${hits.length} privacy violation(s):`);
    for (const hit of hits) {
      console.error(`  - File: ${hit.file} | Path: ${hit.jsonPath ?? 'root'} | Rule: ${hit.rule} | ${hit.snippet}`);
    }
  }

  return { hits, ok: hits.length === 0 };
}

function auditUnstructuredText(file: string, content: string, hits: AuditHit[]): void {
  const authMatch = content.match(AUTH_LITERAL_PATTERN);
  if (authMatch && !isSafePlaceholder(authMatch[0])) {
    hits.push({ file, rule: 'authorization_literal', snippet: authMatch[0].slice(0, 60) });
  }
  for (const secretDef of SECRET_PATTERNS) {
    const match = content.match(secretDef.pattern);
    if (match && !CANARY_STRINGS.some((c) => match[0].includes(c)) && !isSafePlaceholder(match[0])) {
      hits.push({ file, rule: 'secret_pattern', snippet: `Found pattern ${secretDef.name}: ${match[0].slice(0, 30)}...` });
    }
  }
}

const FORBIDDEN_KEYS = new Set([
  'meta',
  'pinData',
  'binary',
  'executionId',
  'instanceId',
  'versionId',
  'jsCode',
  'pythonCode',
  'functionCode',
  'functionItemCode',
  'code',
]);

function checkForbiddenFields(file: string, value: unknown, hits: AuditHit[], pathPrefix = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkForbiddenFields(file, item, hits, `${pathPrefix}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${pathPrefix}.${key}`;
    if (FORBIDDEN_KEYS.has(key) && child !== undefined && child !== null) {
      hits.push({ file, jsonPath: childPath, rule: 'forbidden_field', snippet: `Forbidden field ${key}` });
    }
    const isReadinessCredentialLabels = key === 'credentials'
      && pathPrefix.endsWith('.readiness')
      && Array.isArray(child)
      && child.every((label) => typeof label === 'string');
    if (key === 'credentials' && child && typeof child === 'object' && !isReadinessCredentialLabels) {
      hits.push({ file, jsonPath: childPath, rule: 'forbidden_field', snippet: 'Credential object is not redacted' });
    }
    if (typeof child === 'string') {
      const authMatch = child.match(AUTH_LITERAL_PATTERN);
      if (authMatch && !isSafePlaceholder(authMatch[0])) {
        hits.push({ file, jsonPath: childPath, rule: 'authorization_literal', snippet: authMatch[0].slice(0, 60) });
      }
      for (const definition of SANITIZER_SECRET_PATTERNS) {
        if (definition.keyPattern) definition.keyPattern.lastIndex = 0;
        const pattern = definition.keyPattern ? definition.pattern : withTokenBoundary(definition.pattern);
        pattern.lastIndex = 0;
        const matchesKey = !definition.keyPattern || definition.keyPattern.test(key);
        if (matchesKey && !isSafePlaceholder(child) && pattern.test(child)) {
          hits.push({ file, jsonPath: childPath, rule: 'secret_pattern', snippet: `Found pattern ${definition.name}` });
          break;
        }
      }
    } else {
      checkForbiddenFields(file, child, hits, childPath);
    }
  }
}

function checkOfficialRawSignature(
  file: string,
  val: unknown,
  hits: AuditHit[],
  pathPrefix = '$'
): void {
  if (!val || typeof val !== 'object') return;

  if (Array.isArray(val)) {
    val.forEach((item, idx) => checkOfficialRawSignature(file, item, hits, `${pathPrefix}[${idx}]`));
    return;
  }

  const obj = val as Record<string, unknown>;
  const entry = (obj.entry && typeof obj.entry === 'object' ? obj.entry : obj) as Record<string, unknown>;
  const source = entry.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : undefined;

  if (source && source.kind === 'n8n_official') {
    const rawNodes = Array.isArray(obj.nodes)
      ? obj.nodes
      : Array.isArray(entry.nodes)
      ? entry.nodes
      : undefined;

    if (rawNodes) {
      const hasParameters = rawNodes.some(
        (node) => node && typeof node === 'object' && 'parameters' in (node as Record<string, unknown>)
      );
      if (hasParameters) {
        hits.push({
          file,
          jsonPath: pathPrefix,
          rule: 'official_raw_signature',
          snippet: 'Official n8n workflow entry carries raw node parameters object',
        });
      }
    }
  }
}
