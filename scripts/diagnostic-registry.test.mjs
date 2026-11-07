import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDiagnosticRegistry } from './lib/diagnostic-registry.mjs';
import { CONTRACTS_ARTIFACT, CORE_ARTIFACT, renderDiagnosticRegistryArtifacts } from './lib/diagnostic-registry-generators.mjs';

/**
 * Exactly-once coverage of the diagnostic registry.
 *
 * The normative table is the authority; the artifacts below are projections of it. A row
 * added to the table without regenerating them fails here three ways — the committed
 * artifact no longer reproduces, the runtime registry misses the row, and the contracts
 * vocabulary misses it — so the vocabulary cannot drift from the registry in either
 * direction: no row missed, and no code produced twice.
 */
const ROOT = resolve(import.meta.dirname, '..');
const asTuple = (row) => [row.code, row.category, row.aggregateEffect, row.assessmentEligible, row.v1Code, row.v1Projection];

describe('diagnostic registry coverage', () => {
  const model = loadDiagnosticRegistry(ROOT);
  const codes = model.rows.map((row) => row.code);

  it('reads every registry row exactly once, in table order', () => {
    expect(model.rows.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    expect(model.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps both generated artifacts byte-identical to the registry table', () => {
    const rendered = renderDiagnosticRegistryArtifacts(model);
    expect(Object.keys(rendered).sort()).toEqual([CONTRACTS_ARTIFACT, CORE_ARTIFACT].sort());
    for (const [path, text] of Object.entries(rendered)) {
      expect(readFileSync(resolve(ROOT, path), 'utf8'), `${path} is stale: run 'npm run generate:diagnostic-registry'`).toBe(text);
    }
  });

  it('covers the runtime core registry exactly once', async () => {
    const { DIAGNOSTIC_CODES_V2, DIAGNOSTIC_REGISTRY } = await import('../packages/scanner-core/src/diagnostics/registry.ts');
    const produced = DIAGNOSTIC_REGISTRY.map(asTuple);
    expect(produced.length).toBe(model.rows.length);
    expect(new Set(produced.map((tuple) => tuple[0])).size).toBe(produced.length);
    expect(produced).toEqual(model.rows.map(asTuple));
    expect([...DIAGNOSTIC_CODES_V2]).toEqual(codes);
  });

  it('covers the contracts validator vocabulary exactly once', async () => {
    const { BY_CAPABILITY_DIAGNOSTIC_CODES_V2, DIAGNOSTIC_REGISTRY_V2 } = await import('../contracts/scanner-v2-diagnostics.generated.ts');
    expect(CONTRACTS_ARTIFACT).toBe('contracts/scanner-v2-diagnostics.generated.ts');
    const keys = Object.keys(DIAGNOSTIC_REGISTRY_V2);
    expect(keys).toEqual(codes);
    expect(keys.map((code) => [
      code,
      DIAGNOSTIC_REGISTRY_V2[code][0],
      DIAGNOSTIC_REGISTRY_V2[code][1],
      DIAGNOSTIC_REGISTRY_V2[code][2],
    ])).toEqual(model.rows.map((row) => [row.code, row.category, row.aggregateEffect, row.assessmentEligible]));
    const byCapability = Object.entries(BY_CAPABILITY_DIAGNOSTIC_CODES_V2).filter(([, value]) => value === true).map(([code]) => code);
    expect(byCapability).toEqual(model.rows.filter((row) => row.aggregateEffect === 'BY_CAPABILITY').map((row) => row.code));
  });

  it('resolves the status and assessment mapping exactly as the table declares', async () => {
    const { classifyDiagnostic } = await import('../packages/scanner-core/src/diagnostics/registry.ts');
    for (const row of model.rows) {
      const fixed = {
        category: row.category,
        aggregateEffect: row.aggregateEffect === 'BY_CAPABILITY' ? 'DEGRADED' : row.aggregateEffect,
        assessmentEligible: row.assessmentEligible === 'BY_CAPABILITY' ? true : row.assessmentEligible,
      };
      if (row.aggregateEffect === 'BY_CAPABILITY') {
        expect(classifyDiagnostic(row.code, false), row.code).toEqual(fixed);
        expect(classifyDiagnostic(row.code, true), row.code).toEqual({
          category: row.category, aggregateEffect: 'INDETERMINATE', assessmentEligible: false,
        });
        expect(() => classifyDiagnostic(row.code), row.code).toThrow(TypeError);
      } else {
        expect(classifyDiagnostic(row.code, false), row.code).toEqual(fixed);
        expect(classifyDiagnostic(row.code, true), row.code).toEqual(fixed);
      }
    }
  });
});
