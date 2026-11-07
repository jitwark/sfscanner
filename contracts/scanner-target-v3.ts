import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { TargetContextV3 } from './scanner-v2-result';

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*|0|[1-9][0-9]*)(?:\.(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*|0|[1-9][0-9]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export function isStrictTargetSemver(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SEMVER.exec(value);
  return match !== null && match[0].length === value.length;
}
export function isTargetPackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 214
    && /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/u.test(value)
    && !/[\r\n]/u.test(value);
}
/** Called on the reader's defensive data copy after target shape validation. */
export function validateTargetPairsV3(target: { schemaVersion?: unknown; n8nVersion?: unknown; communityPackages?: unknown }): boolean {
  if (target.schemaVersion !== 'scanner-target-v3' || target.n8nVersion !== undefined && !isStrictTargetSemver(target.n8nVersion)
    || !Array.isArray(target.communityPackages)) return false;
  const names = new Map<string, Set<string | undefined>>();
  let previous = '';
  for (const item of target.communityPackages) {
    if (!item || !isTargetPackageName(item.name) || Object.hasOwn(item, 'version') && !isStrictTargetSemver(item.version)) return false;
    const versions = names.get(item.name) ?? new Set<string | undefined>();
    if (versions.has(item.version) || versions.has(undefined) || item.version === undefined && versions.size > 0) return false;
    const key = `${item.name}\u0000${item.version ?? ''}`;
    if (key <= previous) return false;
    previous = key;
    versions.add(item.version); names.set(item.name, versions);
  }
  return true;
}


/** Target collection order uses Unicode code points, independent of locale and UTF-16 order. */
export function compareTargetCodePointsV3(left: string, right: string): number {
  if (left === right) return 0;
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** Hash validated target data only. Both admission and the defensive result reader use this seam. */
export function createTargetContextDigestV3(target: Omit<TargetContextV3, 'contextDigest'>): string {
  if (target.schemaVersion !== 'scanner-target-v3') throw new TypeError('INVALID_SCHEMA_VERSION');
  // Fields are written in canonical JSON key order; optional fields are absent, never undefined.
  const body = {
    communityPackages: target.communityPackages.map(({ name, version }) => version === undefined ? { name } : { name, version })
      .sort((a, b) => compareTargetCodePointsV3(a.name, b.name) || compareTargetCodePointsV3(a.version ?? '', b.version ?? '')),
    configuration: target.configuration.map(({ key, state }) => ({ key, state }))
      .sort((a, b) => compareTargetCodePointsV3(a.key, b.key) || compareTargetCodePointsV3(a.state, b.state)),
    deployment: target.deployment, edition: target.edition,
    ...(target.n8nVersion === undefined ? {} : { n8nVersion: target.n8nVersion }),
    role: target.role, schemaVersion: target.schemaVersion, taskRunner: target.taskRunner,
  };
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(body))));
}
