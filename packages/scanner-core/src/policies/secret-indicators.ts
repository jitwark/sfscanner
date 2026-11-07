import { classifyProviderToken } from '../analyzers/secrets/provider-token-registry';
import { classifySecretValue } from '../secret-classifier';
import { isNonSecretLiteral } from '../policy/policy-helpers';

export type SecretIndicator = {
  path: string;
  kind: string;
  indicator: 'sensitive_key' | 'sensitive_value';
  hasLiteralValue: boolean;
};

export function collectSecretIndicators(
  value: unknown,
  path = 'parameters',
  contextKey?: string,
): SecretIndicator[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => collectSecretIndicators(child, `${path}[${index}]`, contextKey));
  }

  if (!isRecord(value)) {
    const classification = typeof value === 'string'
      ? classifyProviderToken(value) ?? classifySecretValue(value, contextKey)
      : undefined;
    return classification
      ? [{ path, kind: classification.kind, indicator: 'sensitive_value', hasLiteralValue: true }]
      : [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    const keyKind = secretKindFromKey(key);
    const suppressed = typeof child === 'string' && isNonSecretLiteral(child);
    const nested = collectSecretIndicators(child, childPath, key);
    const valueAlreadyReported = nested.some(
      (indicator) => indicator.path === childPath && indicator.indicator === 'sensitive_value',
    );
    const keyFinding = keyKind && !suppressed && !valueAlreadyReported
      ? [{
          path: childPath,
          kind: keyKind,
          indicator: 'sensitive_key' as const,
          hasLiteralValue: typeof child === 'string' && child.trim().length > 0,
        }]
      : [];
    return [...keyFinding, ...nested];
  });
}

/**
 * n8n fields that name credential *plumbing* — which credential, or which credential type, a
 * node uses — rather than credential material, so a key named like one of them is not itself a
 * secret indicator. The comparison is a whole, case-insensitive key name, so a parameter key
 * that merely contains "credential" (for example `credentialName`) keeps being classified.
 *
 * - `credentials`: n8n's credential reference block (`INode.credentials`, typed
 *   `INodeCredentials` = `{ [credentialType]: { id, name } }`; n8n `packages/workflow/src/interfaces.ts`).
 *   Its value is a reference to the credential store, never the stored secret.
 * - `nodeCredentialType`: the credential *type* selector (the HTTP Request node's "Predefined
 *   Credential Type" field), whose value is a credential type name such as `todoistApi` or
 *   `openAiApi`.
 *
 * These keys are skipped only for the key-name signal: their children are still traversed, so a
 * literal secret nested inside a reference block is still reported as `sensitive_value`.
 */
const CREDENTIAL_PLUMBING_KEYS: Readonly<Record<string, true>> = {
  credentials: true,
  nodecredentialtype: true,
};

function secretKindFromKey(key: string): string | null {
  const normalized = key.toLowerCase();
  if (CREDENTIAL_PLUMBING_KEYS[normalized] === true) return null;
  if (normalized.includes('apikey') || normalized.includes('api_key') || normalized.includes('api-key')) return 'api key';
  if (normalized.includes('password') || normalized.includes('passwd')) return 'password';
  if (normalized.includes('token')) return 'token';
  if (normalized.includes('secret')) return 'secret';
  if (normalized.includes('credential')) return 'credential';
  if (normalized === 'authorization' || normalized === 'cookie') return normalized;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
