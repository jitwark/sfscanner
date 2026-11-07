import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalJsonBytes } from '@hub/scanner-core/canonical-json';
import { scanWorkflowV2, type ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import { describe, expect, it } from 'vitest';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '@hub/scanner-core/test/v2-adapter-fixtures';
import { parseArgumentsV2, type CliCommandV2 } from './arguments';
import type { ReadInputResult } from './input-read';
import { runCliV2Internal as runCliV2 } from './cli-runner-internal';

type ScanCommand = Extract<CliCommandV2, { kind: 'scan' }>;
type JsonEnvelope = {
  schemaVersion: string;
  exitReason: string;
  invocation: { format: string; failOn: string; requireComplete: boolean; concurrency: number };
  supplyChain?: { schemaVersion: string; status: string; inventoryDigest: string; packages: Array<Record<string, string>> };
  results: Array<{
    input: string;
    error?: { code: string };
    result?: { analysis: { status: string }; findings: Array<{ ruleId: string }> };
    readiness?: {
      safetyClearance: string;
      completeness: { status: string; reasons: Array<{ code: string }> };
      prerequisites: {
        credentials: Array<{ credentialType: string }>;
        integrations: Array<{ service: string; evidence: Array<{ source: string; pointer: string; node: string; nodeType: string; typeVersion: string | null }> }>;
        communityNodes: Array<{ packageName: string | null; evidence: Array<{ source: string; pointer: string; node: string }> }>;
        subworkflows: Array<{ node: string; resolution: string }>;
        environment: Array<{ namespace: string; name: string; value: string; availability: string; evidence: { pointer: string; node: string } }>;
        provenance: { source: string; pointer: string; repository: string; commit: string; licence: string; verification: string };
      };
      target: {
        declared: string | null; declaredVersion?: string | null; status: string; migrationTested: boolean;
        findings: Array<{
          code: string; featureId: string; pointer?: string; subject: string; nodeType: string | null; typeVersion: string | null; source: string;
          sourceEvidence?: { kind: string; tag: string; commit: string; path: string; startLine: number; endLine: number; sha256: string };
        }>;
        notes: string[];
      };
    };
  }>;
};

const packageRoot = process.cwd().replaceAll('\\', '/').endsWith('/packages/scanner-cli');
const fixtureDirectory = packageRoot ? 'src/v2/__fixtures__' : 'packages/scanner-cli/src/v2/__fixtures__';
const fixturePath = (name: string): string => `${fixtureDirectory}/${name}`;
const fixture = async (name: string): Promise<Uint8Array> => new TextEncoder().encode(await readFile(fixturePath(name), 'utf8'));
const fixtureText = async (name: string): Promise<string> => readFile(fixturePath(name), 'utf8');

function scanBytes(bytes: Uint8Array, _item?: unknown, options?: { target?: unknown; advisoryRequest?: unknown }): ScanWorkflowV2Result {
  return scanWorkflowV2({
    bytes,
    profile: { id: 'beta-default', version: '2.0.0' },
    limits: DEFAULT_SCANNER_LIMITS_V2,
    ...(options?.target === undefined ? {} : { target: options.target }),
    ...(options?.advisoryRequest === undefined ? {} : { advisoryRequest: options.advisoryRequest }),
  });
}

/** The real runner forwards the CLI target document to the scan, so the result carries the declared n8n version. */
function scanBytesWithTarget(bytes: Uint8Array, _item: unknown, options?: { target?: unknown }): ScanWorkflowV2Result {
  return scanWorkflowV2({
    bytes,
    profile: { id: 'beta-default', version: '2.0.0' },
    limits: DEFAULT_SCANNER_LIMITS_V2,
    ...(options?.target === undefined ? {} : { target: options.target }),
  });
}

function scanCommand(...args: string[]): ScanCommand {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', ...args]);
  if (!parsed.ok || parsed.command.kind !== 'scan') throw new Error('Expected a parsed scan command.');
  return parsed.command;
}

function envelope(stdout: string): JsonEnvelope {
  return JSON.parse(stdout) as JsonEnvelope;
}

async function readByLabel(item: { label: string }): Promise<Uint8Array> {
  if (item.label.endsWith('clean-workflow.json')) return fixture('clean-workflow.json');
  if (item.label.endsWith('risky-workflow.json')) return fixture('risky-workflow.json');
  return fixture('indeterminate-workflow.json');
}

const cleanInput = fixturePath('clean-workflow.json');
const riskyInput = fixturePath('risky-workflow.json');
const indeterminateInput = fixturePath('indeterminate-workflow.json');

describe('runCliV2', () => {
  it('emits a clean JSON envelope and exit 0 with injected dependencies', async () => {
    const result = await runCliV2(scanCommand(cleanInput, '--format', 'json'), {
      cwd: '.',
      read: async () => fixture('clean-workflow.json'),
      scan: scanBytes,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(envelope(result.stdout)).toMatchObject({
      schemaVersion: 'n8n-scan-v2',
      exitReason: 'UNDER_THRESHOLD',
      results: [{ input: cleanInput }],
    });
  });

  it('keeps supply-chain auditing absent by default and makes the opt-in observable', async () => {
    const off = await runCliV2(scanCommand(cleanInput, '--format', 'json'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(off.exitCode).toBe(0);
    expect(envelope(off.stdout)).not.toHaveProperty('supplyChain');

    const on = await runCliV2(scanCommand(cleanInput, '--format', 'json', '--audit-supply-chain',
      '--community-package', 'pkg@1.2.3', '--community-package', 'missing'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(on.exitCode).toBe(0);
    const output = envelope(on.stdout);
    expect(output).not.toEqual(envelope(off.stdout));
    expect(output.supplyChain).toMatchObject({
      schemaVersion: 'supply-chain-request-v2',
      status: 'READY',
      packages: [
        { state: 'UNKNOWN', name: 'missing', reason: 'VERSION_MISSING' },
        { state: 'KNOWN', name: 'pkg', version: '1.2.3' },
      ],
    });
    expect(output.supplyChain!.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(output.supplyChain!.packages[1]!.inventoryDigest).toBe(output.supplyChain!.inventoryDigest);
  });

  it('keeps missing versions and empty inventories explicit and rejects invalid target versions', async () => {
    const missing = await runCliV2(scanCommand(cleanInput, '--audit-supply-chain', '--community-package', 'pkg'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(envelope(missing.stdout).supplyChain).toMatchObject({
      status: 'READY',
      packages: [{ state: 'UNKNOWN', name: 'pkg', reason: 'VERSION_MISSING' }],
    });

    const invalid = await runCliV2(scanCommand(cleanInput, '--audit-supply-chain', '--community-package', 'pkg@latest'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(invalid).toMatchObject({ exitCode: 2, stdout: '', stderr: 'Target context is invalid.\n' });

    const empty = await runCliV2(scanCommand(cleanInput, '--audit-supply-chain'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(envelope(empty.stdout).supplyChain).toMatchObject({ status: 'REFUSED', inventoryState: 'UNVERIFIED', evaluation: { status: 'REFUSED', reason: 'INVENTORY_UNVERIFIED' }, packages: [] });
  });

  it('rejects supply-chain auditing for formats that cannot project the request', async () => {
    const result = await runCliV2(scanCommand(cleanInput, '--audit-supply-chain', '--format', 'table'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    expect(result).toMatchObject({ exitCode: 2, stdout: '', stderr: 'Supply-chain audit requires JSON or NDJSON output.\n' });
  });

  it('projects the opt-in request into the NDJSON header', async () => {
    const result = await runCliV2(scanCommand(cleanInput, '--audit-supply-chain', '--format', 'ndjson', '--community-package', 'pkg@1.2.3'), { read: async () => fixture('clean-workflow.json'), scan: scanBytes });
    const header = JSON.parse(result.stdout.trimEnd().split('\n')[0]!) as { type: string; supplyChain?: { status: string; packages: Array<Record<string, string>> } };
    expect(header).toMatchObject({ type: 'header', supplyChain: { status: 'READY', packages: [{ state: 'KNOWN', name: 'pkg', version: '1.2.3' }] } });
  });

  it.each(['json', 'ndjson', 'sarif', 'table'] as const)('selects the existing %s serializer', async (format) => {
    const result = await runCliV2(scanCommand(cleanInput, '--format', format), {
      read: async () => fixture('clean-workflow.json'),
      scan: scanBytes,
    });

    expect(result.exitCode).toBe(0);
    if (format === 'json') expect(envelope(result.stdout).schemaVersion).toBe('n8n-scan-v2');
    if (format === 'ndjson') {
      const lines = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { schemaVersion: string; type: string });
      expect(lines.map(({ schemaVersion, type }) => [schemaVersion, type])).toEqual([
        ['n8n-scan-v2-ndjson', 'header'],
        ['n8n-scan-v2-ndjson', 'result'],
        ['n8n-scan-v2-ndjson', 'summary'],
      ]);
    }
    if (format === 'sarif') expect(JSON.parse(result.stdout)).toMatchObject({ version: '2.1.0', runs: expect.any(Array) });
    if (format === 'table') expect(result.stdout).toContain('Input');
  });
  it('omits readiness by default and reports it under the explicit opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-readiness-'));
    try {
      await writeFile(join(directory, 'readiness.json'), JSON.stringify({
        name: 'Readiness workflow',
        nodes: [
          { id: 'notify', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 2, parameters: {}, credentials: { slackApi: { id: 'cred-1', name: 'Slack account' } } },
          { id: 'fetch', name: 'Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, parameters: { url: '={{ $env.SERVICE_URL }}' } },
          { id: 'custom', name: 'Custom', type: 'example-nodes.action', typeVersion: 1, parameters: {} },
        ],
        connections: {},
      }));

      // The community node is a LOW-severity package finding, so the readiness projection is asserted above the verdict.
      const scanReadiness = (...args: string[]): ScanCommand => scanCommand('readiness.json', '--fail-on', 'CRITICAL', ...args);

      const bareJson = await runCliV2(scanReadiness('--format', 'json'), { cwd: directory, scan: scanBytes });
      expect(bareJson.exitCode).toBe(0);
      expect(envelope(bareJson.stdout).results[0]?.readiness).toBeUndefined();
      const bareTable = await runCliV2(scanReadiness('--format', 'table'), { cwd: directory, scan: scanBytes });
      expect(bareTable.exitCode).toBe(0);
      expect(bareTable.stdout).not.toContain('Readiness (declared workflow prerequisites');
      const bareNdjson = await runCliV2(scanReadiness('--format', 'ndjson'), { cwd: directory, scan: scanBytes });
      const bareNdjsonLines = bareNdjson.stdout.trimEnd().split('\n').map((raw) => JSON.parse(raw) as { item?: { readiness?: unknown } });
      expect(bareNdjsonLines.every(({ item }) => item === undefined || item.readiness === undefined)).toBe(true);
      expect(bareNdjson.stdout).not.toContain('Readiness (declared workflow prerequisites');

      const json = await runCliV2(scanReadiness('--format', 'json', '--include-readiness'), { cwd: directory, scan: scanBytes });
      const readiness = envelope(json.stdout).results[0]?.readiness;
      expect(json.exitCode).toBe(0);
      expect(readiness?.completeness.status).toBe('DEGRADED');
      expect(readiness?.safetyClearance).toBe('NOT_PROVIDED');
      expect(readiness?.prerequisites.credentials.map(({ credentialType }) => credentialType)).toEqual(['slackApi']);
      expect(readiness?.prerequisites.integrations.map(({ service }) => service)).toEqual(['httpRequest', 'slack']);
      expect(readiness?.prerequisites.integrations[0]?.evidence).toEqual([
        { source: 'WORKFLOW_EXPORT', pointer: '/nodes/1', node: 'Fetch', nodeType: 'n8n-nodes-base.httpRequest', typeVersion: '4' },
      ]);
      expect(readiness?.prerequisites.communityNodes[0]?.evidence).toEqual([
        { source: 'WORKFLOW_EXPORT', pointer: '/nodes/2', node: 'Custom', nodeType: 'example-nodes.action', typeVersion: '1' },
      ]);
      expect(readiness?.prerequisites.environment).toEqual([
        { namespace: 'ENV', name: 'SERVICE_URL', value: 'UNKNOWN', availability: 'UNKNOWN', evidence: expect.objectContaining({ pointer: '/nodes/1/parameters/url', node: 'Fetch' }) },
      ]);
      expect(readiness?.prerequisites.provenance).toEqual({
        source: 'WORKFLOW_EXPORT', pointer: '/', repository: 'UNKNOWN', commit: 'UNKNOWN', licence: 'UNKNOWN', verification: 'UNKNOWN',
      });

      const table = await runCliV2(scanReadiness('--format', 'table', '--include-readiness'), { cwd: directory, scan: scanBytes });
      expect(table.exitCode).toBe(0);
      expect(table.stdout).toContain('Readiness (declared workflow prerequisites; offline and unverified)');
      expect(table.stdout).toMatch(/completeness +DEGRADED/);
      expect(table.stdout).toMatch(/credentials +slackApi/);
      expect(table.stdout).toMatch(/integrations +httpRequest, slack/);
      expect(table.stdout).toMatch(/environment +\$env\.SERVICE_URL/);
      expect(table.stdout).toMatch(/provenance +WORKFLOW_EXPORT \/ \(repository, commit, licence, verification UNKNOWN\)/);
      expect(table.stdout).not.toContain('{{');
      expect(table.stdout).toContain('NOT_SAFETY_CLEARANCE');

      const ndjson = await runCliV2(scanReadiness('--format', 'ndjson', '--include-readiness'), { cwd: directory, scan: scanBytes });
      expect(ndjson.exitCode).toBe(0);
      const resultLine = ndjson.stdout.trimEnd().split('\n')
        .map((raw) => JSON.parse(raw) as { type: string; item?: { input: string; readiness?: { completeness: { status: string } } } })
        .find(({ type }) => type === 'result');
      expect(resultLine?.item?.readiness?.completeness.status).toBe('DEGRADED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to project a readiness assessment into SARIF', async () => {
    expect(parseArgumentsV2(['--schema', 'v2', 'scan', cleanInput, '--format', 'sarif', '--include-readiness']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VALUE', argument: '--include-readiness' } });

    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-readiness-sarif-'));
    try {
      await writeFile(join(directory, 'scan.json'), JSON.stringify({ schemaVersion: 'n8n-scan-config-v2', format: 'sarif' }));
      const result = await runCliV2(scanCommand(cleanInput, '--config', 'scan.json', '--include-readiness'), {
        cwd: directory,
        read: async () => fixture('clean-workflow.json'),
        scan: scanBytes,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('Readiness assessment cannot be projected into SARIF.\n');
      expect(result.stdout).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports every exported node for a complete analysis larger than the capability schedule', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-readiness-wide-'));
    try {
      const nodes = [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
        ...Array.from({ length: 29 }, (_, index) => ({ id: `n${index}`, name: `Step ${index}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} })),
      ];
      await writeFile(join(directory, 'wide.json'), JSON.stringify({ name: 'Wide workflow', nodes, connections: {} }));

      const json = await runCliV2(scanCommand('wide.json', '--format', 'json', '--include-readiness'), { cwd: directory, scan: scanBytes });
      const readiness = envelope(json.stdout).results[0]?.readiness;

      expect(readiness?.completeness.status).toBe('COMPLETE');
      expect(readiness?.completeness.reasons).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('projects exact pinned findings through both CLI target selectors and opt-in renderers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-exact-target-'));
    try {
      const canary = 'cli-command-canary-a942';
      await writeFile(join(directory, 'workflow.json'), JSON.stringify({
        name: 'Exact target workflow',
        nodes: [{ id: 'command', name: 'Command', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: canary } }],
        connections: {},
      }));
      await writeFile(join(directory, 'target.json'), JSON.stringify({ schemaVersion: 'scanner-target-v3', n8nVersion: '2.45.6' }));
      const run = (args: string[]) => runCliV2(scanCommand('workflow.json', ...args), { cwd: directory, scan: scanBytesWithTarget });

      const direct = await run(['--format', 'json', '--include-readiness', '--n8n-version', '2.0.0']);
      const directReadiness = envelope(direct.stdout).results[0]?.readiness;
      expect(direct.stderr).toBe('');
      expect(directReadiness?.target).toMatchObject({ declaredVersion: '2.0.0', status: 'INDETERMINATE', migrationTested: false });
      expect(directReadiness?.target.findings).toEqual([expect.objectContaining({
        code: 'DEFAULT_NODE_EXCLUSION_CONFIGURATION_UNKNOWN', featureId: 'execute-command-default-exclusion', pointer: '/nodes/0/type',
        nodeType: 'n8n-nodes-base.executeCommand', typeVersion: '1',
        sourceEvidence: expect.objectContaining({ kind: 'PINNED_SOURCE', tag: 'n8n@2.0.0', startLine: 29, endLine: 36 }),
      })]);
      expect(direct.stdout).not.toContain(canary);

      const configured = await run(['--format', 'json', '--include-readiness', '--target', 'target.json']);
      const configuredReadiness = envelope(configured.stdout).results[0]?.readiness;
      expect(configured.stderr).toBe('');
      expect(configuredReadiness?.target).toMatchObject({ declaredVersion: '2.45.6', status: 'INDETERMINATE', migrationTested: false });
      expect(configuredReadiness?.target.findings[0]).toMatchObject({
        pointer: '/nodes/0/type', sourceEvidence: { tag: 'n8n@2.45.6', sha256: '1f57a7f5044d4dc2df9b5880669fa37cc4928e4564c378c8e0aef17db30b5aa3', startLine: 31, endLine: 39 },
      });

      const ndjson = await run(['--format', 'ndjson', '--include-readiness', '--n8n-version', '2.0.0']);
      const resultLine = ndjson.stdout.trimEnd().split('\n').map((raw) => JSON.parse(raw) as { type: string; item?: JsonEnvelope['results'][number] })
        .find(({ type }) => type === 'result');
      expect(ndjson.stderr).toBe('');
      expect(resultLine?.item?.readiness?.target).toMatchObject({ declaredVersion: '2.0.0', status: 'INDETERMINATE' });

      const table = await run(['--format', 'table', '--include-readiness', '--n8n-version', '2.0.0']);
      expect(table.stderr).toBe('');
      expect(table.stdout).toMatch(/target +INDETERMINATE/);
      expect(table.stdout).not.toContain('88f7169b');
      expect(table.stdout).not.toContain('/nodes/0/type');

      expect(() => scanCommand('--n8n-version', '2.0')).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lists declared subworkflows in the table readiness block', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-subworkflow-'));
    try {
      await writeFile(join(directory, 'parent.json'), JSON.stringify({
        name: 'Parent workflow',
        nodes: [
          { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
          { id: 'child', name: 'Run child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: 'child-workflow' } },
        ],
        connections: {},
      }));

      const table = await runCliV2(scanCommand('parent.json', '--format', 'table', '--include-readiness'), { cwd: directory, scan: scanBytes });

      expect(table.exitCode).toBe(0);
      expect(table.stdout).toMatch(/subworkflows +Run child/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures the raw BatchItemV2 result before CLI envelope projection', async () => {
    const parityFixture = V2_ADAPTER_FIXTURE_MATRIX.find(({ id }) => id === 'safe-workflow')!;
    const sourceBytes = new TextEncoder().encode(parityFixture.json);
    const expected = scanWorkflowV2({ bytes: sourceBytes, profile: V2_ADAPTER_PROFILE, limits: DEFAULT_SCANNER_LIMITS_V2 });
    const captured: ScanWorkflowV2Result[] = [];
    const result = await runCliV2(scanCommand('-', '--format', 'json', '--fail-on', 'CRITICAL'), {
      stdin: sourceBytes,
      scan: (bytes) => {
        const raw = scanBytes(bytes);
        captured.push(raw);
        return raw;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(expected.ok).toBe(true);
    expect(captured).toHaveLength(1);
    if (expected.ok && captured[0]?.ok) expect(canonicalJsonBytes(captured[0].result)).toEqual(canonicalJsonBytes(expected.result));
  });

  it('scans the committed clean fixture from disk without rewriting its bytes', async () => {
    const result = await runCliV2(scanCommand(cleanInput, '--format', 'json'));
    expect(result.exitCode).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ exitReason: 'UNDER_THRESHOLD', results: [{ input: cleanInput }] });
  });
  it('keeps whitespace and CRLF webhook authentication findings through the CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sf-cli-webhook-'));
    try {
      await writeFile(join(directory, 'webhook-auth.json'), JSON.stringify({
        nodes: [' basicAuth ', 'jwtAuth\r\n'].map((authentication, index) => ({ id: `w${index}`, name: `Webhook ${index}`, type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { authentication } })),
        connections: {},
      }));
      // The default reader takes the bytes from disk; only the scan is injected so the assertion is
      // about the CLI's projection of a real v2 result, not about a worker spawn.
      const result = await runCliV2(scanCommand('webhook-auth.json', '--format', 'json', '--fail-on', 'CRITICAL'), { cwd: directory, scan: scanBytes });
      const output = envelope(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(output.exitReason).toBe('UNDER_THRESHOLD');
      expect(output.results[0]?.result?.analysis.status).toBe('COMPLETE');
      expect(output.results[0]?.result?.findings.map(({ ruleId }) => ruleId)).toEqual(['WEBHOOK_EXPOSURE', 'WEBHOOK_EXPOSURE']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns FINDING_THRESHOLD and exit 1 for findings at the configured threshold', async () => {
    const result = await runCliV2(scanCommand(riskyInput, '--format', 'json', '--fail-on', 'HIGH'), {
      read: async () => fixture('risky-workflow.json'),
      scan: scanBytes,
    });

    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).invocation).toMatchObject({ format: 'json', failOn: 'HIGH', requireComplete: false, concurrency: 1 });
    expect(envelope(result.stdout).exitReason).toBe('FINDING_THRESHOLD');
  });

  it('returns ITEM_FAILURE and exit 3 for indeterminate results without a finding threshold', async () => {
    const scanned = scanBytes(await fixture('indeterminate-workflow.json'));
    if (!scanned.ok) throw new Error(scanned.code);
    const withoutFindings: ScanWorkflowV2Result = { ok: true, result: { ...scanned.result, findings: [] } };
    const result = await runCliV2(scanCommand(indeterminateInput, '--format', 'json'), {
      read: async () => fixture('indeterminate-workflow.json'),
      scan: async () => withoutFindings,
    });

    expect(result.exitCode).toBe(3);
    expect(envelope(result.stdout).exitReason).toBe('ITEM_FAILURE');
  });

  it('keeps malformed and oversized input failures closed and source-safe', async () => {
    const sentinel = 'task-2-private-source-sentinel';
    const malformed = await runCliV2(scanCommand(cleanInput), {
      read: async () => new TextEncoder().encode(`{"secret":"${sentinel}"`),
    });
    const oversized = await runCliV2(scanCommand(cleanInput), {
      read: async (item): Promise<ReadInputResult> => ({ ok: false, code: 'WORKFLOW_TOO_LARGE', message: sentinel, label: item.label }),
    });

    expect(malformed.exitCode).toBe(3);
    expect(envelope(malformed.stdout).results[0]?.error?.code).toBe('INVALID_JSON');
    expect(oversized.exitCode).toBe(3);
    expect(envelope(oversized.stdout).results[0]?.error?.code).toBe('WORKFLOW_TOO_LARGE');
    expect(`${malformed.stdout}\n${malformed.stderr}\n${oversized.stdout}\n${oversized.stderr}`).not.toContain(sentinel);
  });

  it('sorts multiple input labels deterministically despite concurrent scanning', async () => {
    const result = await runCliV2(scanCommand(riskyInput, cleanInput, indeterminateInput, '--format', 'json', '--concurrency', '2'), {
      read: readByLabel,
      scan: async (bytes) => {
        await Promise.resolve();
        return scanBytes(bytes);
      },
    });

    expect(envelope(result.stdout).results.map(({ input }) => input)).toEqual([cleanInput, indeterminateInput, riskyInput]);
  });

  it('accepts stdin as one item and rejects a mixed stdin/file batch', async () => {
    const stdin = await fixtureText('clean-workflow.json');
    const result = await runCliV2(scanCommand('-'), { stdin, scan: scanBytes });
    const mixed = parseArgumentsV2(['--schema', 'v2', 'scan', '-', cleanInput]);

    expect(result.exitCode).toBe(0);
    expect(envelope(result.stdout).results.map(({ input }) => input)).toEqual(['-']);
    expect(mixed).toMatchObject({ ok: false, error: { code: 'UNEXPECTED_ARGUMENT' } });
  });

  it('preserves cancellation semantics for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let scanCalled = false;
    const result = await runCliV2(scanCommand(cleanInput), {
      signal: controller.signal,
      scan: async (bytes) => {
        scanCalled = true;
        return scanBytes(bytes);
      },
    });

    expect(result.exitCode).toBe(130);
    expect(envelope(result.stdout).exitReason).toBe('CANCELLED');
    expect(scanCalled).toBe(false);
  });
  it('emits a cancelled envelope when SIGINT aborts directory input selection', async () => {
    const controller = new AbortController();
    const directoryHost = {
      readdir: async () => {
        controller.abort();
        return [];
      },
      lstat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
      stat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
      realpath: async (path: string) => path,
    };
    const result = await runCliV2(scanCommand('workflows'), { signal: controller.signal, selectionHost: directoryHost });
    expect(result.exitCode).toBe(130);
    expect(result.stdout).not.toBe('');
    expect(envelope(result.stdout).exitReason).toBe('CANCELLED');
  });

  it('returns usage for an output collision without modifying the input', async () => {
    const before = await readFile(cleanInput);
    let readCalled = false;
    const result = await runCliV2(scanCommand(cleanInput, '--output', cleanInput), {
      read: async () => {
        readCalled = true;
        return fixture('clean-workflow.json');
      },
      scan: scanBytes,
    });
    const after = await readFile(cleanInput);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(readCalled).toBe(false);
    expect(after).toEqual(before);
  });
});
