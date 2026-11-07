import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ID_PLACEHOLDER,
  CREDENTIAL_NAME_PLACEHOLDER,
  HEADER_VALUE_PLACEHOLDER,
  INTERNAL_URL_PLACEHOLDER,
  PRIVACY_PREPARE_DISCLAIMER_V1,
  PRIVACY_PREPARE_SCHEMA_V1,
  TOKEN_PLACEHOLDER,
  WEBHOOK_ID_PLACEHOLDER,
  WEBHOOK_PATH_PLACEHOLDER,
  prepareWorkflowPrivacy,
} from './privacy-prepare';

type Dict = Record<string, unknown>;

type WorkflowLike = Readonly<{ nodes: readonly Readonly<Dict>[]; connections: Dict } & Dict>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Dict)) deepFreeze(child);
  }
  return value;
}

function credentialNode(extra: Dict = {}): Dict {
  return {
    id: 'node-cred',
    name: 'Create order',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    position: [240, 120],
    parameters: {},
    credentials: { httpHeaderAuth: { id: 'cred-9f8e7d', name: 'Prod Orders API' } },
    ...extra,
  };
}

function workflow(nodes: readonly Dict[], extra: Dict = {}): Dict {
  return {
    name: 'Privacy workflow',
    nodes: [...nodes],
    connections: { Start: { main: [[{ node: 'Create order', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    ...extra,
  };
}

const SENSITIVE_WORKFLOW = (): WorkflowLike => workflow([
  { id: 'node-start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
  credentialNode(),
  {
    id: 'node-http',
    name: 'Fetch internal orders',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    position: [480, 120],
    parameters: {
      url: 'http://10.20.30.40:8080/api/orders?token=abc123secret',
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: 'Bearer sk-live-abcdef123456' },
          { name: 'Accept', value: 'application/json' },
        ],
      },
    },
  },
  {
    id: 'node-hook',
    name: 'Inbound hook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [760, 120],
    parameters: { httpMethod: 'POST', path: 'prod-orders/9f8e7d6c5b4a' },
  },
  {
    id: 'node-profile',
    name: 'Enrich profile',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    position: [1000, 120],
    parameters: { url: 'https://api.example.com/v1/profile?api_key=abc123secret', password: 'hunter2' },
  },
]) as WorkflowLike;

describe('workflow privacy preparation', () => {
  it('never mutates the input workflow, even when the input is deeply frozen', () => {
    // Arrange
    const input = deepFreeze(SENSITIVE_WORKFLOW());
    const snapshot = JSON.stringify(input);

    // Act
    const result = prepareWorkflowPrivacy(input);

    // Assert
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result.workflow).not.toBe(input);
    expect((result.workflow.nodes as readonly unknown[])[1]).not.toBe(input.nodes[1]);
    expect(Object.isFrozen(input.nodes[1])).toBe(true);
  });

  it('clears credential ids and names while keeping the credential type key', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const prepared = prepareWorkflowPrivacy(input).workflow as WorkflowLike;
    const node = prepared.nodes[1] as Dict;
    const credential = (node.credentials as Dict).httpHeaderAuth as Dict;

    // Assert
    expect(credential.id).toBe(CREDENTIAL_ID_PLACEHOLDER);
    expect(credential.name).toBe(CREDENTIAL_NAME_PLACEHOLDER);
    expect(Object.keys(node.credentials as Dict)).toEqual(['httpHeaderAuth']);
  });

  it('redacts sensitive authorization headers and leaves ordinary headers intact', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const prepared = prepareWorkflowPrivacy(input).workflow as WorkflowLike;
    const parameters = (prepared.nodes[2] as Dict).parameters as Dict;
    const headers = (parameters.headerParameters as Dict).parameters as readonly Dict[];

    // Assert
    expect(headers[0]).toEqual({ name: 'Authorization', value: HEADER_VALUE_PLACEHOLDER });
    expect(headers[1]).toEqual({ name: 'Accept', value: 'application/json' });
  });

  it('rewrites private, loopback and internal-domain URLs to a placeholder', () => {
    // Arrange
    const internalUrls = [
      'http://10.20.30.40:8080/api/orders',
      'http://localhost:5678/rest/items',
      'http://localhost./private',
      'http://192.168.1.10/admin',
      'https://billing.internal/v2/invoices',
      'http://win-box:3000/health',
    ];

    // Act
    const prepared = prepareWorkflowPrivacy(workflow(internalUrls.map((url, index) => ({
      id: `node-${index}`, name: `Url ${index}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [index, 0], parameters: { url },
    })))).workflow as WorkflowLike;

    // Assert
    for (const node of prepared.nodes) expect((node.parameters as Dict).url).toBe(INTERNAL_URL_PLACEHOLDER);
  });

  it('redacts webhook paths, embedded query tokens and secret parameter values', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const result = prepareWorkflowPrivacy(input);
    const prepared = result.workflow as WorkflowLike;

    // Assert
    expect(((prepared.nodes[3] as Dict).parameters as Dict).path).toBe(WEBHOOK_PATH_PLACEHOLDER);
    expect(((prepared.nodes[2] as Dict).parameters as Dict).url).toBe(INTERNAL_URL_PLACEHOLDER);
    expect(((prepared.nodes[4] as Dict).parameters as Dict).password).toBe(TOKEN_PLACEHOLDER);
    expect(((prepared.nodes[4] as Dict).parameters as Dict).url).toBe('https://api.example.com/v1/profile?api_key=[REDACTED_TOKEN]');
    expect(result.changes.map((change) => change.kind)).toContain('TOKEN');
  });

  it('preserves the workflow graph: node count, ids, names, positions and connections', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const prepared = prepareWorkflowPrivacy(input).workflow as WorkflowLike;

    // Assert
    expect(prepared.nodes).toHaveLength(input.nodes.length);
    expect(prepared.connections).toEqual(input.connections);
    expect(prepared.connections).not.toBe(input.connections);
    expect(prepared.settings).toEqual({ executionOrder: 'v1' });
    prepared.nodes.forEach((node, index) => {
      const original = input.nodes[index] as Dict;
      expect(node.id).toBe(original.id);
      expect(node.name).toBe(original.name);
      expect(node.type).toBe(original.type);
      expect(node.position).toEqual(original.position);
    });
  });

  it('reports each change with a pointer path, kind, excerpt and replacement', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const result = prepareWorkflowPrivacy(input);
    const kinds = new Set(result.changes.map((change) => change.kind));

    // Assert
    expect(kinds).toEqual(new Set(['CREDENTIAL', 'HEADER', 'INTERNAL_URL', 'TOKEN']));
    expect(result.changed).toBe(true);
    for (const change of result.changes) {
      expect(change.path.startsWith('/nodes/')).toBe(true);
      expect(change.replacement.length).toBeGreaterThan(0);
    }
    const credentialChange = result.changes.find((change) => change.path === '/nodes/1/credentials/httpHeaderAuth/id');
    expect(credentialChange).toEqual({
      path: '/nodes/1/credentials/httpHeaderAuth/id',
      kind: 'CREDENTIAL',
      originalExcerpt: 'cred-9f8e7d',
      replacement: CREDENTIAL_ID_PLACEHOLDER,
    });
    const headerChange = result.changes.find((change) => change.path === '/nodes/2/parameters/headerParameters/parameters/0/value');
    expect(headerChange?.originalExcerpt).toBe('Bearer sk-live-abcdef123456');
    expect(headerChange?.kind).toBe('HEADER');
    expect(result.changes.map((change) => change.path)).toEqual([...result.changes.map((change) => change.path)].sort());
  });

  it('emits a unified-style diff whose removed and added lines show the exact before and after values', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const { diff } = prepareWorkflowPrivacy(input);

    // Assert
    expect(diff.startsWith('--- workflow.before.json\n+++ workflow.after.json\n')).toBe(true);
    expect(diff).toMatch(/\n@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).not.toMatch(/^[-+].*"Accept"/m);
    expect(diff).toMatch(/^-.*"id": "cred-9f8e7d",$/m);
    expect(diff).toMatch(/^\+.*"id": "\[REDACTED_CREDENTIAL_ID\]",$/m);
    expect(diff).toMatch(/^-.*"value": "Bearer sk-live-abcdef123456"$/m);
    expect(diff).toMatch(/^\+.*"value": "\[REDACTED_HEADER_VALUE\]"$/m);
    expect(diff).toContain('"url": "http://10.20.30.40:8080/api/orders?token=abc123secret"');
    expect(diff).toContain(`"url": "${INTERNAL_URL_PLACEHOLDER}"`);
  });

  it('discloses that complete redaction is not guaranteed', () => {
    // Arrange
    const input = workflow([{ id: 'node-a', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }]);

    // Act
    const result = prepareWorkflowPrivacy(input);

    // Assert
    expect(result.schemaVersion).toBe(PRIVACY_PREPARE_SCHEMA_V1);
    expect(result.completeRedactionGuaranteed).toBe(false);
    expect(result.disclaimer).toBe(PRIVACY_PREPARE_DISCLAIMER_V1);
    expect(result.disclaimer).toContain('Does NOT guarantee complete secret or PII removal');
    expect(result.disclaimer).toContain('sensitive local review material');
    expect(result.disclaimer).toContain('never share or upload');
  });

  it('states that the raw diff carries the original removed values', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();

    // Act
    const { diff } = prepareWorkflowPrivacy(input);

    // Assert
    expect(diff).toContain('sk-live-abcdef123456');
    expect(PRIVACY_PREPARE_DISCLAIMER_V1).toBe(
      'Heuristic and rule-bounded privacy preparation. Does NOT guarantee complete secret or PII removal. '
      + 'The raw diff and change excerpts contain the original removed values and are sensitive local review material; never share or upload them.',
    );
    expect(PRIVACY_PREPARE_DISCLAIMER_V1).toContain('raw diff');
    expect(PRIVACY_PREPARE_DISCLAIMER_V1).toContain('original removed values');
    expect(PRIVACY_PREPARE_DISCLAIMER_V1).toContain('sensitive local review material');
  });

  it('returns no changes and an empty diff for a workflow without sensitive literals', () => {
    // Arrange
    const input = workflow([
      { id: 'node-a', name: 'Public call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: { url: 'https://api.example.com/v1/items' } },
    ]);

    // Act
    const result = prepareWorkflowPrivacy(input);

    // Assert
    expect(result.changes).toEqual([]);
    expect(result.diff).toBe('');
    expect(result.changed).toBe(false);
    expect(result.workflow).toEqual(input);
  });

  it('is deterministic, idempotent and honors an internal URL placeholder override', () => {
    // Arrange
    const input = SENSITIVE_WORKFLOW();
    const options = { internalUrlPlaceholder: 'https://scrubbed.invalid/url' } as const;

    // Act
    const first = prepareWorkflowPrivacy(input, options);
    const second = prepareWorkflowPrivacy(input, options);
    const again = prepareWorkflowPrivacy(first.workflow, options);

    // Assert
    expect(second).toEqual(first);
    expect(again.changes).toEqual([]);
    expect(again.diff).toBe('');
    expect(((first.workflow.nodes as readonly Dict[])[2].parameters as Dict).url).toBe('https://scrubbed.invalid/url');
  });

  it('stays a browser-safe, bounded module', () => {
    const source = readFileSync(new URL('./privacy-prepare.ts', import.meta.url), 'utf8');
    expect(source.split('\n').length).toBeLessThanOrEqual(250);
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bprocess\./);
  });

  it('rejects a workflow that is not an object', () => {
    expect(() => prepareWorkflowPrivacy(null)).toThrow(TypeError);
    expect(() => prepareWorkflowPrivacy('workflow')).toThrow(TypeError);
    expect(() => prepareWorkflowPrivacy([])).toThrow(TypeError);
  });

  it('keeps a __proto__ key as an own property and never pollutes Object.prototype', () => {
    // Arrange
    const input = JSON.parse('{"name":"Proto","nodes":[],"connections":{},"__proto__":{"polluted":true}}') as Dict;

    // Act
    const result = prepareWorkflowPrivacy(input);

    // Assert
    expect((Object.prototype as unknown as Dict).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.workflow)).toBe(Object.prototype);
    const descriptor = Object.getOwnPropertyDescriptor(result.workflow, '__proto__');
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.value).toEqual({ polluted: true });
    expect(Object.keys(result.workflow)).toContain('__proto__');
    const roundTripped = JSON.parse(JSON.stringify(result.workflow)) as Dict;
    expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')?.value).toEqual({ polluted: true });
  });

  it('deep-copies non-dict credential details instead of aliasing the input', () => {
    // Arrange
    const scopes = ['https://api.example.com/one', 'https://api.example.com/two'];
    const input = workflow([{
      id: 'node-a', name: 'A', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: {},
      credentials: { httpHeaderAuth: { id: 'cred-1' }, oauth2Api: scopes },
    }]);

    // Act
    const prepared = prepareWorkflowPrivacy(input).workflow as WorkflowLike;
    const credentials = (prepared.nodes[0] as Dict).credentials as Dict;

    // Assert
    expect(credentials.oauth2Api).toEqual(scopes);
    expect(credentials.oauth2Api).not.toBe(scopes);
    (credentials.oauth2Api as string[]).push('https://api.example.com/three');
    expect(scopes).toEqual(['https://api.example.com/one', 'https://api.example.com/two']);
    expect(credentials.httpHeaderAuth).toEqual({ id: CREDENTIAL_ID_PLACEHOLDER });
  });

  it('honors operator-supplied internal host suffixes in addition to the defaults', () => {
    // Arrange
    const input = workflow([{
      id: 'node-a', name: 'A', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0],
      parameters: { url: 'https://billing.partner.example/v1/invoices' },
    }]);

    // Act
    const defaulted = prepareWorkflowPrivacy(input);
    const customized = prepareWorkflowPrivacy(input, { internalHostSuffixes: ['.example'] });

    // Assert
    expect(((defaulted.workflow.nodes as readonly Dict[])[0].parameters as Dict).url).toBe('https://billing.partner.example/v1/invoices');
    expect(defaulted.changes).toEqual([]);
    expect(((customized.workflow.nodes as readonly Dict[])[0].parameters as Dict).url).toBe(INTERNAL_URL_PLACEHOLDER);
    expect(customized.changes.map((change) => change.kind)).toEqual(['INTERNAL_URL']);
  });

  it('redacts node-level webhook ids and IPv6 internal endpoints but keeps public IPv6 URLs', () => {
    // Arrange
    const input = workflow([
      { id: 'node-hook', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'a1b2c3d4e5f6', parameters: { path: 'orders' } },
      { id: 'node-ula', name: 'Ula', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [1, 0], parameters: { url: 'http://[fd12:3456:789a::1]:8080/api' } },
      { id: 'node-mapped', name: 'Mapped', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [2, 0], parameters: { url: 'http://[::ffff:10.1.2.3]:9000/api' } },
      { id: 'node-public', name: 'Public', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [3, 0], parameters: { url: 'http://[2606:4700::1111]/api' } },
    ]);

    // Act
    const prepared = prepareWorkflowPrivacy(input).workflow as WorkflowLike;
    const url = (index: number): unknown => ((prepared.nodes[index] as Dict).parameters as Dict).url;

    // Assert
    expect((prepared.nodes[0] as Dict).webhookId).toBe(WEBHOOK_ID_PLACEHOLDER);
    expect(url(1)).toBe(INTERNAL_URL_PLACEHOLDER);
    expect(url(2)).toBe(INTERNAL_URL_PLACEHOLDER);
    expect(url(3)).toBe('http://[2606:4700::1111]/api');
  });

  it('rejects options that are not an object', () => {
    // Arrange
    const call = (options: unknown) =>
      prepareWorkflowPrivacy({ nodes: [], connections: {} }, options as Parameters<typeof prepareWorkflowPrivacy>[1]);

    // Assert
    expect(() => call(null)).toThrow(TypeError);
    expect(() => call([])).toThrow(TypeError);
    expect(() => call('options')).toThrow(TypeError);
    expect(() => call(42)).toThrow(TypeError);
  });

  it('rejects malformed option fields instead of trusting untyped JSON', () => {
    // Arrange
    const call = (options: unknown) =>
      prepareWorkflowPrivacy({ nodes: [], connections: {} }, options as Parameters<typeof prepareWorkflowPrivacy>[1]);

    // Assert
    expect(() => call({ internalHostSuffixes: '.example' })).toThrow(TypeError);
    expect(() => call({ internalHostSuffixes: [42] })).toThrow(TypeError);
    expect(() => call({ internalHostSuffixes: ['.ok', null] })).toThrow(TypeError);
    expect(() => call({ internalUrlPlaceholder: 42 })).toThrow(TypeError);
  });

  it('rejects blank placeholders, non-dotted suffixes and unknown option keys', () => {
    // Arrange
    const call = (options: unknown) =>
      prepareWorkflowPrivacy({ nodes: [], connections: {} }, options as Parameters<typeof prepareWorkflowPrivacy>[1]);

    // Act
    const blankPlaceholder = () => call({ internalUrlPlaceholder: '   ' });
    const emptyPlaceholder = () => call({ internalUrlPlaceholder: '' });
    const bareTld = () => call({ internalHostSuffixes: ['com'] });
    const emptySuffix = () => call({ internalHostSuffixes: [''] });
    const dottedTld = () => call({ internalHostSuffixes: ['.'] });
    const unknownKey = () => call({ internalHostSuffix: ['.example'] });

    // Assert
    expect(blankPlaceholder).toThrow(TypeError);
    expect(emptyPlaceholder).toThrow(TypeError);
    expect(bareTld).toThrow(TypeError);
    expect(emptySuffix).toThrow(TypeError);
    expect(dottedTld).toThrow(TypeError);
    expect(unknownKey).toThrow(TypeError);
  });

  it('redacts octal, dword and hex spellings of loopback and private IPv4 hosts', () => {
    // Arrange
    const internalUrls = [
      'http://0177.0.0.1/private',
      'http://[::ffff:a00:1]/private',
      'http://[::ffff:7f00:1]/private',
      'http://127.0.0.1/private',
      'http://[::ffff:10.0.0.1]/private',
    ];
    const input = workflow(internalUrls.map((url, index) => ({
      id: `node-${index}`, name: `Url ${index}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [index, 0], parameters: { url },
    })));
    const snapshot = JSON.stringify(input);

    // Act
    const result = prepareWorkflowPrivacy(input);
    const urls = (result.workflow.nodes as readonly Dict[]).map((node) => (node.parameters as Dict).url);

    // Assert
    expect(urls).toEqual(internalUrls.map(() => INTERNAL_URL_PLACEHOLDER));
    expect(INTERNAL_URL_PLACEHOLDER.startsWith('https://internal.example.invalid/')).toBe(true);
    expect(result.changes.map((change) => change.kind)).toEqual(internalUrls.map(() => 'INTERNAL_URL'));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('leaves public hosts and public IPv6 endpoints untouched', () => {
    // Arrange
    const publicUrls = ['https://example.com/api', 'https://api.github.com/users', 'http://[2001:4860:4860::8888]/dns'];
    const input = workflow(publicUrls.map((url, index) => ({
      id: `node-${index}`, name: `Url ${index}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [index, 0], parameters: { url },
    })));

    // Act
    const result = prepareWorkflowPrivacy(input);
    const urls = (result.workflow.nodes as readonly Dict[]).map((node) => (node.parameters as Dict).url);

    // Assert
    expect(urls).toEqual(publicUrls);
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.diff).toBe('');
  });

  it('redacts short labelled bearer and basic tokens inside parameters', () => {
    // Arrange
    const input = workflow([{
      id: 'node-a', name: 'A', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0],
      parameters: { note: 'Authorization: Bearer abc', alt: 'Bearer test123', basic: 'Basic dGVzdA==' },
    }]);

    // Act
    const parameters = ((prepareWorkflowPrivacy(input).workflow.nodes as readonly Dict[])[0] as Dict).parameters as Dict;

    // Assert
    expect(parameters.note).toBe('Authorization: Bearer [REDACTED_TOKEN]');
    expect(parameters.alt).toBe('Bearer [REDACTED_TOKEN]');
    expect(parameters.basic).toBe('Basic [REDACTED_TOKEN]');
  });
});
