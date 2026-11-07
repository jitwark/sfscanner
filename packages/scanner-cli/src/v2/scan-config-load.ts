import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateScannerLimitsV2, type ScannerLimitsV2 } from '@hub/contracts';
import { ADMITTED_CONFIGURATION_KEYS_V2, validateTargetContextV3 } from '@hub/scanner-core/v2';
import type { CliCommandV2 } from './arguments';
import { loadExplicitConfig, type ScanConfigV2 } from './config';
import type { ProjectionSourceV2 } from './json-output';
import type { ExitCodeV2 } from './exit-reducer';

type ScanCommand = Extract<CliCommandV2, { kind: 'scan' }>;
const MAX_INPUT_DOCUMENT_BYTES = 1_048_576;
type JsonDocumentRead = Readonly<{ ok: true; value: unknown } | { ok: false }>;

export type LoadedScanConfig = Readonly<{
  ok: true;
  config: ScanConfigV2;
  limitsDocument?: ScannerLimitsV2;
  targetDocument?: unknown;
  inventoryState?: 'DECLARED' | 'UNVERIFIED';
  sources: ProjectionSourceV2;
}> | Readonly<{ ok: false; exitCode: ExitCodeV2; message: string }>;

/** Bounded before allocation; invalid UTF-8/JSON fails closed. */
async function readJson(baseDirectory: string, relative: string): Promise<JsonDocumentRead> {
  const handle = await open(resolve(baseDirectory, relative), 'r').catch(() => undefined);
  if (handle === undefined) return Object.freeze({ ok: false as const });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_DOCUMENT_BYTES) return Object.freeze({ ok: false as const });
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    return Object.freeze({ ok: true as const, value: JSON.parse(text) as unknown });
  } catch {
    return Object.freeze({ ok: false as const });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readScanConfig(command: ScanCommand, baseDirectory: string): Promise<LoadedScanConfig> {
  let source: unknown = { schemaVersion: 'n8n-scan-config-v2' };
  if (command.configPath !== undefined) {
    try {
      source = await readFile(resolve(baseDirectory, command.configPath), 'utf8');
    } catch {
      return Object.freeze({ ok: false as const, exitCode: 2 as const, message: 'Configuration could not be read.' });
    }
  }
  const loaded = loadExplicitConfig(source, { configDirectory: baseDirectory, cli: command.cliOverrides });
  if (!loaded.ok) return Object.freeze({ ok: false as const, exitCode: 2 as const, message: 'Configuration is invalid.' });

  const invalid = (message: string): LoadedScanConfig => Object.freeze({ ok: false as const, exitCode: 2 as const, message });

  let limitsDocument: ScannerLimitsV2 | undefined;
  if (loaded.config.limits !== undefined && loaded.config.limits !== 'builtin') {
    const file = await readJson(baseDirectory, loaded.config.limits);
    if (!file.ok) return invalid('Limits could not be read.');
    const checked = validateScannerLimitsV2(file.value);
    if (!checked.ok) return invalid('Limits are invalid.');
    limitsDocument = checked.limits;
  }

  let targetDocument: unknown;
  let inventoryState: 'DECLARED' | 'UNVERIFIED' | undefined;
  if (loaded.config.target !== undefined) {
    const file = await readJson(baseDirectory, loaded.config.target);
    if (!file.ok) return invalid('Target context could not be read.');
    targetDocument = file.value;
    if (targetDocument === null || typeof targetDocument !== 'object' || Array.isArray(targetDocument)
      || (targetDocument as Record<string, unknown>).schemaVersion !== 'scanner-target-v3') return invalid('Target context is invalid.');
    if (targetDocument !== null && typeof targetDocument === 'object' && !Array.isArray(targetDocument)
      && Object.prototype.hasOwnProperty.call(targetDocument, 'communityPackages')) inventoryState = 'DECLARED';
  }
  const targetOverrides = targetFromCommand(command);
  const hasTargetOverrides = Object.keys(targetOverrides).length > 0;
  if (targetDocument !== undefined || hasTargetOverrides) {
    if (targetDocument !== undefined && (typeof targetDocument !== 'object' || targetDocument === null || Array.isArray(targetDocument))) {
      return invalid('Target context is invalid.');
    }
    const base = (targetDocument ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { schemaVersion: 'scanner-target-v3', ...base, ...targetOverrides };
    if (hasTargetOverrides) delete merged.contextDigest;
    try {
      targetDocument = validateTargetContextV3(merged, {
        allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2,
      });
    } catch { return invalid('Target context is invalid.'); }
    inventoryState = inventoryState ?? (command.communityPackages.length > 0 ? 'DECLARED' : 'UNVERIFIED');
  }

  let configRecord: Record<string, unknown> = {};
  if (typeof source === 'string') {
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) configRecord = parsed as Record<string, unknown>;
    } catch {
      configRecord = {};
    }
  } else if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    configRecord = source as Record<string, unknown>;
  }
  const cliRecord = command.cliOverrides as Record<string, unknown>;
  const sourceFor = (key: string): 'BUILT_IN' | 'CONFIG' | 'CLI' => Object.prototype.hasOwnProperty.call(cliRecord, key)
    ? 'CLI'
    : Object.prototype.hasOwnProperty.call(configRecord, key) ? 'CONFIG' : 'BUILT_IN';
  const targetFlagged = hasTargetOverrides || command.approvedDomains.length > 0;
  const targetSource = sourceFor('target');
  const unsignedSource = sourceFor('allowUnsignedDevelopmentRules');
  return Object.freeze({
    ok: true as const,
    config: loaded.config,
    ...(limitsDocument === undefined ? {} : { limitsDocument }),
    ...(targetDocument === undefined ? {} : { targetDocument }),
    ...(inventoryState === undefined ? {} : { inventoryState }),
    sources: Object.freeze({
      profile: sourceFor('profile'),
      rules: sourceFor('rules'),
      semantics: sourceFor('catalogue'),
      limits: sourceFor('limits'),
      target: targetFlagged ? 'CLI' : targetSource === 'BUILT_IN' ? 'DEFAULT' : targetSource,
      unsignedDevelopment: unsignedSource === 'BUILT_IN' ? 'DEFAULT' : unsignedSource,
    }),
  });
}

function targetFromCommand(command: ScanCommand): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (command.n8nVersion !== undefined) target.n8nVersion = command.n8nVersion;
  if (command.edition !== 'UNKNOWN') target.edition = command.edition;
  if (command.deployment !== 'UNKNOWN') target.deployment = command.deployment;
  if (command.role !== 'UNKNOWN') target.role = command.role;
  if (command.taskRunner !== 'UNKNOWN') target.taskRunner = command.taskRunner;
  if (command.communityPackages.length > 0) {
    target.communityPackages = command.communityPackages.map((value) => {
      const at = value.lastIndexOf('@');
      return at > 0 ? { name: value.slice(0, at), version: value.slice(at + 1) } : { name: value };
    });
  }
  if (command.configuration.length > 0) target.configuration = command.configuration.map((key) => ({ key, state: 'UNKNOWN' }));
  return target;
}
