import type { CliCommandV2 } from './arguments.js';
import { runCliV2Internal } from './cli-runner-internal.js';

/** The scan member only: the internal runner does not dispatch metadata commands. */
export type PublicScanCommandV2 = Extract<CliCommandV2, { kind: 'scan' }>;
export type PublicRunOptionsV2 = Readonly<{
  cwd?: string;
  stdin?: string | Uint8Array | AsyncIterable<Uint8Array | string>;
  signal?: AbortSignal;
}>;
export type PublicRunResultV2 = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  document?: unknown;
}>;

/**
 * Library entry. The `sfscanner` bin remains the side-effecting CLI; this wrapper forwards only
 * the three consumer options, so an internal read/scan/selection hook is never part of the
 * published surface.
 */
export async function runCliV2(command: PublicScanCommandV2, options: PublicRunOptionsV2 = {}): Promise<PublicRunResultV2> {
  return runCliV2Internal(command, { cwd: options.cwd, stdin: options.stdin, signal: options.signal });
}
