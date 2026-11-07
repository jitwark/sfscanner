import {
  DEFAULT_SCANNER_LIMITS_V2,
  validateScannerLimitsV2,
  type ScannerLimitsV2,
} from '@hub/contracts';

const LIMIT_FIELDS = Object.freeze(Object.getOwnPropertyNames(DEFAULT_SCANNER_LIMITS_V2));

export function resolveScannerLimits(partial: unknown): ScannerLimitsV2 | undefined {
  try {
    if (partial === undefined) return DEFAULT_SCANNER_LIMITS_V2;
    if (!plainDataRecord(partial)) return undefined;
    const candidate = Object.create(null) as Record<string, unknown>;
    for (const field of LIMIT_FIELDS) candidate[field] = DEFAULT_SCANNER_LIMITS_V2[field as keyof ScannerLimitsV2];
    for (const field of Object.getOwnPropertyNames(partial)) {
      if (!LIMIT_FIELDS.includes(field)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(partial, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
      candidate[field] = descriptor.value;
    }
    if (Object.getOwnPropertySymbols(partial).length > 0) return undefined;
    const result = validateScannerLimitsV2(candidate);
    return result.ok ? result.limits : undefined;
  } catch {
    return undefined;
  }
}

function plainDataRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const field of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
  }
  return true;
}
