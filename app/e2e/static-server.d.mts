import type { Server } from 'node:http';

/**
 * Types for `static-server.mjs`, which the app's `tsconfig.json` keeps out of
 * the program: it sets `allowJs: false` and includes only TypeScript files.
 * The server stays a `.mjs` script because Playwright, `visual-baselines.mjs`,
 * `measure-baseline.mjs` and `probe-lib.mjs` all spawn it with `node`. This
 * declaration is the contract its importers — today `e2e/static-server.test.ts`
 * — can rely on.
 */

export declare const DEFAULT_PORT: number;

/** An inclusive byte window, `'unsatisfiable'`, or "ignore the header". */
export type ResolvedRange = { start: number; end: number } | 'unsatisfiable' | null;

export declare function resolveRange(header: string | undefined, size: number): ResolvedRange;

export declare function createStaticServer(options?: {
  root?: string;
  /** Site prefix without slashes, e.g. `secureflow`; empty means served at the root. */
  basePath?: string;
}): Server;
