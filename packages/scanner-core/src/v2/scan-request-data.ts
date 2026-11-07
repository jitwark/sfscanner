import type { AdvisoryRequestV3 } from '../advisories/advisory-evaluation';
type Plain = Record<string, unknown>;
export function record(value: unknown, allowed: readonly string[], required: readonly string[] = []): Plain | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(value); const output = Object.create(null) as Plain;
    for (const name of names) { if (!allowed.includes(name)) return undefined; const descriptor = Object.getOwnPropertyDescriptor(value, name); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined; output[name] = descriptor.value; }
    if (required.some((name) => !names.includes(name))) return undefined;
    return output;
  } catch { return undefined; }
}
/** A dense array of strings, or `undefined`: a sparse array or any non-string member is malformed. */
export function domainList(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value); const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || names.length !== length + 1 || !names.includes('length')) return undefined;
    const output: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch { return undefined; }
}
export function advisoryRequest(value: unknown): AdvisoryRequestV3 | undefined {
  const item = record(value, ['requested', 'inventoryState'], ['requested', 'inventoryState']);
  if (!item || typeof item.requested !== 'boolean' || (item.inventoryState !== 'DECLARED' && item.inventoryState !== 'UNVERIFIED')) return undefined;
  return Object.freeze({ requested: item.requested, inventoryState: item.inventoryState });
}
