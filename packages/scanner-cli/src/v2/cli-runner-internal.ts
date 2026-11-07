import type { CliStdin, InputReadHost } from './input-read';
import { collectInputs, type InputSelectionHost } from './input-selection';
import type { CliCommandV2 } from './arguments';
import { readScanConfig } from './scan-config-load';
import { buildSupplyChainRequest, type SupplyChainRequestV2 } from './supply-chain-request';
import { ADMITTED_CONFIGURATION_KEYS_V2, validateTargetContextV3, type TargetContextV3 } from '@hub/scanner-core/v2';
import type { ScanConfigV2 } from './config';
import { runBatchV2, type BatchReadV2, type BatchScanV2, type BatchResultV2 } from './batch-runner';
import { serializeEnvelopeV2, projectBatchV2, type CliEnvelopeV2, type ProjectionOptionsV2, type ProjectionSourceV2 } from './json-output';
import { serializeNdjsonV2 } from './ndjson-output';
import { serializeSarifV2 } from '@hub/scanner-core/report/sarif-v2/output';
import { renderTableV2 } from './table-output';
import { reduceExitV2, type ExitCodeV2 } from './exit-reducer';
import { writeAtomicOutputV2 } from './atomic-output';
import type { SigintSource } from './worker-host';
import { type SnapshotTransportV1 } from './supply-chain-fetch';
import type { SnapshotPinV1 } from './supply-chain-snapshot';
export type V2CliRunOptions = Readonly<{
  cwd?: string;
  stdin?: CliStdin;
  signal?: AbortSignal;
  read?: BatchReadV2;
  scan?: BatchScanV2;
  readHost?: InputReadHost;
  selectionHost?: InputSelectionHost;
  sigint?: SigintSource;
  transport?: SnapshotTransportV1;
  snapshotPin?: SnapshotPinV1;
  now?: () => number;
}>;

export type V2CliRunResult = Readonly<{
  exitCode: ExitCodeV2;
  stdout: string;
  stderr: string;
  document?: CliEnvelopeV2 | string;
}>;

type ScanCommand = Extract<CliCommandV2, { kind: 'scan' }>;
type SerializedDocument = Readonly<{ output: string; document: CliEnvelopeV2 | string }>;
type SuccessfulBatch = Extract<BatchResultV2, { ok: true }>;

export async function runCliV2Internal(command: ScanCommand, options: V2CliRunOptions = {}): Promise<V2CliRunResult> {
  const baseDirectory = options.cwd ?? process.cwd();
  const config = await readScanConfig(command, baseDirectory);
  if (!config.ok) return failure(config.exitCode, config.message);

  const format = config.config.format ?? command.format;
  if (command.includeReadiness && format === 'sarif') return failure(2, 'Readiness assessment cannot be projected into SARIF.');
  if (command.auditSupplyChain && format !== 'json' && format !== 'ndjson') {
    return failure(2, 'Supply-chain audit requires JSON or NDJSON output.');
  }
  let supplyChain: SupplyChainRequestV2 | undefined;
  let supplyTarget: TargetContextV3 | undefined;
  let advisoryRequest: Readonly<{ requested: boolean; inventoryState: 'DECLARED' | 'UNVERIFIED' }> | undefined;
  if (command.auditSupplyChain) {
    try {
      const target = config.targetDocument === undefined
        ? validateTargetContextV3({ schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [] }, { allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2 })
        : validateTargetContextV3(config.targetDocument, { allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2 });
      supplyTarget = target;
      const inventoryState = config.inventoryState ?? 'UNVERIFIED';
      advisoryRequest = Object.freeze({ requested: true, inventoryState });
      // No authentic release-owned receipt is installed. Pins and transport hooks cannot authorize acquisition.
      supplyChain = buildSupplyChainRequest({ enabled: true, target, inventoryState });
    } catch {
      return failure(2, 'Target context is invalid.');
    }
  }

  const selected = await collectInputs({
    inputs: config.config.inputs ?? [],
    include: config.config.include,
    exclude: config.config.exclude,
    baseDirectory,
    host: options.selectionHost,
    outputPath: config.config.output,
    signal: options.signal,
  });
  if (!selected.ok) {
    if (selected.code !== 'CANCELLED') return failure(2, selected.message);
    const cancelled: SuccessfulBatch = Object.freeze({ ok: true as const, items: Object.freeze([]), cancelled: true, completed: 0, failed: 0, concurrency: config.config.concurrency ?? 1 });
    const serialized = serializeBatch(cancelled, format, config.config, config.sources, supplyChain, supplyTarget, command.includeReadiness);
    return config.config.output !== undefined && config.config.output !== '-'
      ? Object.freeze({ exitCode: 130 as const, stdout: '', stderr: '', document: serialized.document })
      : Object.freeze({ exitCode: 130 as const, stdout: serialized.output, stderr: '', document: serialized.document });
  }

  let batch: BatchResultV2;
  try {
    batch = await runBatchV2({
      items: selected.inputs,
      config: config.config,
      read: options.read,
      scan: options.scan,
      stdin: options.stdin,
      readHost: options.readHost,
      baseDirectory,
      limitsDocument: config.limitsDocument,
      targetDocument: config.targetDocument,
      approvedDomains: config.config.approvedDomains,
      timeoutMs: command.timeoutMs,
      signal: options.signal,
      sigint: options.sigint ?? process,
      advisoryRequest,
      includeReadiness: command.includeReadiness,
    });
  } catch {
    return failure(4, 'Internal scanner failure.');
  }

  const reduction = reduceExitV2(batch, { failOn: config.config.failOn, requireComplete: config.config.requireComplete });
  if (!batch.ok) return failure(reduction.code, reduction.reason === 'CANCELLED' ? '' : 'Configuration is invalid.');

  let serialized: SerializedDocument;
  try {
    serialized = serializeBatch(batch, format, config.config, config.sources, supplyChain, supplyTarget, command.includeReadiness);
  } catch {
    const exit = reduceExitV2(batch, { failOn: config.config.failOn, requireComplete: config.config.requireComplete, outputFailed: true });
    return failure(exit.code, 'Output could not be written.');
  }

  if (config.config.output !== undefined && config.config.output !== '-') {
    if (reduction.reason === 'CANCELLED') return Object.freeze({ exitCode: reduction.code, stdout: '', stderr: '', document: serialized.document });
    const output = await writeAtomicOutputV2(config.config.output, serialized.output, {
      baseDirectory,
      inputPaths: selected.inputs.filter((item) => !item.isStdin).map((item) => item.realPath ?? item.label),
      signal: options.signal,
    });
    if (!output.ok) {
      const exit = reduceExitV2(batch, {
        failOn: config.config.failOn,
        requireComplete: config.config.requireComplete,
        interrupted: output.code === 'CANCELLED',
        outputFailed: output.code !== 'CANCELLED',
      });
      return Object.freeze({ exitCode: exit.code, stdout: '', stderr: output.code === 'CANCELLED' ? '' : `${output.message}\n` });
    }
    return Object.freeze({ exitCode: reduction.code, stdout: '', stderr: '', document: serialized.document });
  }

  return Object.freeze({ exitCode: reduction.code, stdout: serialized.output, stderr: '', document: serialized.document });
}

function serializeBatch(batch: SuccessfulBatch, format: ScanConfigV2['format'], config: ScanConfigV2, sources: ProjectionSourceV2, supplyChain?: SupplyChainRequestV2, target?: TargetContextV3, includeReadiness?: boolean): SerializedDocument {
  const projection = projectionOptions(config, format, sources, supplyChain, target, includeReadiness);
  if (format === 'json' || format === undefined) {
    return Object.freeze({ output: serializeEnvelopeV2(batch, projection), document: projectBatchV2(batch, projection).envelope });
  }
  if (format === 'ndjson') {
    const output = serializeNdjsonV2(batch, projection);
    return Object.freeze({ output, document: output });
  }
  if (format === 'sarif') {
    const output = serializeSarifV2({ items: batch.items });
    return Object.freeze({ output, document: output });
  }
  if (format === 'table') {
    const output = renderTableV2(batch, projection);
    return Object.freeze({ output, document: output });
  }
  throw new TypeError('Invalid format');
}

function projectionOptions(config: ScanConfigV2, format: ScanConfigV2['format'], sources: ProjectionSourceV2, supplyChain?: SupplyChainRequestV2, target?: TargetContextV3, includeReadiness?: boolean): ProjectionOptionsV2 {
  return Object.freeze({
    format: format === 'ndjson' ? 'ndjson' : 'json',
    profile: config.profile ?? 'beta-default',
    failOn: config.failOn ?? 'INFO',
    requireComplete: config.requireComplete ?? false,
    concurrency: config.concurrency ?? 1,
    allowUnsignedDevelopmentRules: config.allowUnsignedDevelopmentRules ?? false,
    sources: Object.freeze({ ...sources }),
    ...(supplyChain === undefined ? {} : { supplyChain }),
    ...(target === undefined ? {} : { target }),
    ...(includeReadiness === true ? { includeReadiness: true } : {}),
  });
}

function failure(exitCode: ExitCodeV2, message: string): V2CliRunResult {
  return Object.freeze({ exitCode, stdout: '', stderr: message ? `${message}\n` : '' });
}
