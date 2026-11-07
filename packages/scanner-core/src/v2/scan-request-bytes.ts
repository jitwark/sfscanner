import type { ScanWorkflowV2Failure } from './scan-workflow';

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'byteLength')?.get;

export type ScanRequestBytesOutcome =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; failure: ScanWorkflowV2Failure };

export function extractAdmittedBytes(value: unknown, maxBytes: number): ScanRequestBytesOutcome {
  try {
    if (
      !(value instanceof Uint8Array) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      !TYPED_ARRAY_BYTE_LENGTH_GETTER
    ) {
      return { ok: false, failure: Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Scanner bytes must be a Uint8Array.' }) };
    }

    const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      return { ok: false, failure: Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Scanner bytes must be a Uint8Array.' }) };
    }

    if (byteLength > maxBytes) {
      return {
        ok: false,
        failure: Object.freeze({
          ok: false,
          code: 'WORKFLOW_TOO_LARGE',
          message: 'Workflow payload exceeds the configured byte limit.',
          cause: 'PAYLOAD_BYTE_LIMIT',
        }),
      };
    }

    const names = Object.getOwnPropertyNames(value);
    if (names.length !== byteLength) {
      return { ok: false, failure: Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Scanner bytes must be a Uint8Array.' }) };
    }

    const copied = new Uint8Array(byteLength);
    copied.set(value.subarray(0, byteLength));
    return { ok: true, bytes: copied };
  } catch {
    return { ok: false, failure: Object.freeze({ ok: false, code: 'INVALID_CONFIG', message: 'Scanner bytes must be a Uint8Array.' }) };
  }
}
