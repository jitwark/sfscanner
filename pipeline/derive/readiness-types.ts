/**
 * Minimal per-node shape the readiness derivers need. `readiness.ts` extracts
 * this once from the untrusted raw node object so every signal function below
 * it works against a narrow, already-typed shape instead of re-checking
 * `unknown` at every call site.
 */
export type ReadinessNode = {
  type: string;
  name: string;
  parameters: unknown;
  credentials: unknown;
  typeVersion: unknown;
};
