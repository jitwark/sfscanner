import { open } from 'node:fs/promises';
import { LIMITS } from '@hub/contracts';

export type CliStdin = string | AsyncIterable<Uint8Array | string>;

/** The v1 ceiling is the shared workflow-byte authority, not a second number. */
export const MAX_V1_INPUT_BYTES = LIMITS.maxWorkflowBytes;

export async function readWorkflowInput(input: string, stdin: CliStdin = process.stdin): Promise<string> {
  if (input !== '-') {
    const handle = await open(input, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RangeError('NOT_REGULAR_FILE');
      if (stat.size > MAX_V1_INPUT_BYTES) throw new RangeError('OVERSIZED');
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } finally {
      await handle.close();
    }
  }
  if (typeof stdin === 'string') {
    if (Buffer.byteLength(stdin, 'utf8') > MAX_V1_INPUT_BYTES) throw new RangeError('OVERSIZED');
    return stdin;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_V1_INPUT_BYTES) throw new RangeError('OVERSIZED');
    chunks.push(bytes);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}
