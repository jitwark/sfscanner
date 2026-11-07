/** Structural preflight for bounded JSON bytes. It is a guard, never a parser replacement. */
export type StructuralLimits = Readonly<{
  maxBytes: number; maxDepth: number; maxTokens: number; maxRawStringBytes: number; maxWork: number;
}>;
export type Preflight =
  | Readonly<{ ok: true; work: number; maxDepthSeen: number; tokens: number }>
  | Readonly<{ ok: false; reason: 'BYTES' | 'DEPTH' | 'TOKENS' | 'STRING' | 'WORK' | 'MALFORMED'; examinedBytes: number }>;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const HEX = /^[0-9a-fA-F]{4}$/;

export function preflightJson(bytes: Uint8Array, limits: StructuralLimits): Preflight {
  if (bytes.length > limits.maxBytes) return { ok: false, reason: 'BYTES', examinedBytes: bytes.length };
  try {
    utf8.decode(bytes);
  } catch {
    return { ok: false, reason: 'MALFORMED', examinedBytes: bytes.length };
  }
  const stack: number[] = [];
  let work = 0;
  let tokens = 0;
  let maxDepthSeen = 0;
  let index = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  work = index;
  const fail = (reason: 'DEPTH' | 'TOKENS' | 'STRING' | 'WORK' | 'MALFORMED', at = index): Preflight =>
    ({ ok: false, reason, examinedBytes: Math.max(at, work) });
  const count = (at: number): Preflight | undefined => {
    tokens += 1;
    if (tokens > limits.maxTokens) return fail('TOKENS', at);
    return undefined;
  };
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (work + 1 > limits.maxWork) return fail('WORK');
    work += 1;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) { index += 1; continue; }
    if (byte === 0x7b || byte === 0x5b) {
      if (stack.length + 1 > limits.maxDepth) return fail('DEPTH');
      stack.push(byte === 0x7b ? 0x7d : 0x5d);
      maxDepthSeen = Math.max(maxDepthSeen, stack.length);
      const over = count(index); if (over) return over; index += 1; continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      if (stack.pop() !== byte) return fail('MALFORMED');
      const over = count(index); if (over) return over; index += 1; continue;
    }
    if (byte === 0x3a || byte === 0x2c) { const over = count(index); if (over) return over; index += 1; continue; }
    if (byte === 0x22) {
      const start = index; index += 1;
      for (;;) {
        if (index >= bytes.length) return fail('MALFORMED');
        if (work + 1 > limits.maxWork) return fail('WORK');
        work += 1;
        const current = bytes[index]!;
        if (current === 0x22) { index += 1; break; }
        if (current === 0x5c) {
          index += 1;
          if (index >= bytes.length) return fail('MALFORMED');
          const escape = bytes[index]!;
          if (escape === 0x75) {
            const hex = String.fromCharCode(...bytes.subarray(index + 1, index + 5));
            if (!HEX.test(hex)) return fail('MALFORMED');
            for (let offset = 0; offset < 5; offset += 1) {
              if (work + 1 > limits.maxWork) return fail('WORK');
              work += 1;
            }
            index += 5; continue;
          }
          if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escape)) return fail('MALFORMED');
          if (work + 1 > limits.maxWork) return fail('WORK');
          work += 1;
          index += 1; continue;
        }
        if (current < 0x20) return fail('MALFORMED');
        index += 1;
        if (index - start > limits.maxRawStringBytes) return fail('STRING');
      }
      if (index - start > limits.maxRawStringBytes) return fail('STRING');
      const over = count(start); if (over) return over; continue;
    }
    if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      const start = index; index += 1;
      while (index < bytes.length && /[0-9eE+.\-]/.test(String.fromCharCode(bytes[index]!))) {
        if (work + 1 > limits.maxWork) return fail('WORK');
        work += 1; index += 1;
      }
      let token = '';
      for (let offset = start; offset < index; offset += 4096) {
        token += String.fromCharCode(...bytes.subarray(offset, Math.min(index, offset + 4096)));
      }
      if (!NUMBER.test(token)) return fail('MALFORMED');
      const over = count(start); if (over) return over; continue;
    }
    const rest = String.fromCharCode(...bytes.subarray(index, index + 5));
    const literalLength = rest.startsWith('true') || rest.startsWith('null') ? 4 : rest.startsWith('false') ? 5 : 0;
    if (literalLength === 0) return fail('MALFORMED');
    for (let offset = 1; offset < literalLength; offset += 1) {
      if (work + 1 > limits.maxWork) return fail('WORK', index + offset);
      work += 1;
    }
    index += literalLength;
    const over = count(index - literalLength); if (over) return over; continue;
  }
  if (stack.length !== 0 || tokens === 0) return fail('MALFORMED');
  return { ok: true, work, maxDepthSeen, tokens };
}
