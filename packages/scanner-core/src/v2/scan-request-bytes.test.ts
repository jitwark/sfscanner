import { describe, expect, it } from 'vitest';
import { extractAdmittedBytes } from './scan-request-bytes';

describe('extractAdmittedBytes', () => {
  it('copies valid bytes when byte length is within maxBytes', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const outcome = extractAdmittedBytes(original, 10);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(outcome.bytes).not.toBe(original);

    // Mutation after copy does not affect copied bytes:
    original[0] = 99;
    expect(outcome.bytes[0]).toBe(1);
  });

  it('handles boundary cases: max - 1, max, and max + 1', () => {
    const max = 16;
    const under = new Uint8Array(max - 1);
    const exact = new Uint8Array(max);
    const over = new Uint8Array(max + 1);

    expect(extractAdmittedBytes(under, max).ok).toBe(true);
    expect(extractAdmittedBytes(exact, max).ok).toBe(true);

    const overResult = extractAdmittedBytes(over, max);
    expect(overResult.ok).toBe(false);
    if (overResult.ok) return;
    expect(overResult.failure.code).toBe('WORKFLOW_TOO_LARGE');
    expect(overResult.failure.cause).toBe('PAYLOAD_BYTE_LIMIT');
  });

  it('rejects fake objects and objects with forged prototypes', () => {
    const fake = { byteLength: 5, 0: 1, 1: 2 };
    Object.setPrototypeOf(fake, Uint8Array.prototype);
    const outcome = extractAdmittedBytes(fake, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects proxies over Uint8Array', () => {
    const proxy = new Proxy(new Uint8Array(4), {});
    const outcome = extractAdmittedBytes(proxy, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects subclasses of Uint8Array', () => {
    class SubclassedUint8Array extends Uint8Array {}
    const sub = new SubclassedUint8Array(4);
    const outcome = extractAdmittedBytes(sub, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects Uint8Array instances with symbol properties or missing descriptors', () => {
    const withSymbol = new Uint8Array(4);
    const sym = Symbol('sneaky');
    (withSymbol as unknown as Record<symbol, unknown>)[sym] = 'payload';
    const outcome = extractAdmittedBytes(withSymbol, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects instances with an own overridden byteLength property', () => {
    const overridden = new Uint8Array(5);
    Object.defineProperty(overridden, 'byteLength', {
      get() {
        return 2;
      },
      configurable: true,
    });
    const outcome = extractAdmittedBytes(overridden, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects instances with an own constructor or non-index property attempting Symbol.species exploitation', () => {
    const withConstructor = new Uint8Array(4);
    Object.defineProperty(withConstructor, 'constructor', {
      value: { [Symbol.species]: class InjectedArray extends Uint8Array {} },
      enumerable: false,
      configurable: true,
    });
    const outcome = extractAdmittedBytes(withConstructor, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects instances with any extra own non-numeric properties', () => {
    const withExtra = new Uint8Array(4);
    Object.defineProperty(withExtra, 'customMeta', {
      value: 'evil',
      enumerable: true,
      configurable: true,
    });
    const outcome = extractAdmittedBytes(withExtra, 10);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });

  it('rejects detached ArrayBuffers safely without unhandled throws', () => {
    const buffer = new ArrayBuffer(16);
    const detached = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    const outcome = extractAdmittedBytes(detached, 16);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('INVALID_CONFIG');
  });
});
