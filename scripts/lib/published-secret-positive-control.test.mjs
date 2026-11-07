import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOOSE_RULE, STRICT_RULES } from './published-secret-candidates.mjs';
import { runPositiveControl } from './published-secret-positive-control.mjs';

describe('published secret gate positive control', () => {
  it('plants one value per rule class and detects every one of them', async () => {
    const control = await runPositiveControl();
    expect(control.plantedValues).toBe(5);
    expect(control.detectedValues).toBe(5);
    expect(control.strictClasses).toEqual([
      STRICT_RULES.BASIC_HEADER,
      STRICT_RULES.BEARER_HEADER,
      STRICT_RULES.CREDENTIAL_VALUE,
    ].sort());
    expect(control.looseClasses).toEqual([LOOSE_RULE]);
    expect(control.lineArtifactDetected).toBe(true);
  });

  /**
   * The field paths are asserted, not just the fact of a hit: a control that
   * proved "something matched somewhere" would not prove the structural
   * resolver — the part that turns a leak into an actionable location — works.
   */
  it('resolves an exact field path for every planted value', async () => {
    const control = await runPositiveControl();
    expect(control.fieldPaths).toEqual([
      '$.nodes[0].credentials.httpBasicAuth.password',
      '$.nodes[0].credentials.httpBasicAuth.user',
      '$.nodes[0].parameters.headerParameters.parameters[0].value',
      '$.nodes[0].parameters.headerParameters.parameters[1].value',
      '$.nodes[0].parameters.headerParameters.parameters[2].value',
    ]);
  });

  it('leaves no temporary artifact behind by default', async () => {
    const control = await runPositiveControl();
    expect(control.directory).toBeUndefined();
    expect(control.artifactFiles).toBeUndefined();
  });

  it('retains the artifact only when asked, for the red demonstration', async () => {
    const control = await runPositiveControl({ retainArtifacts: true });
    expect(control.artifactFiles).toHaveLength(2);
    for (const file of control.artifactFiles) expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(control.directory, { recursive: true, force: true });
    expect(fs.existsSync(control.artifactFiles[0])).toBe(false);
  });

  /**
   * A leak gate whose report quoted what it hunts would have published the thing
   * it exists to protect. Everything the control reports is counts, rule classes
   * and field paths; the planted needles ride beside the report and the gate
   * strips them before serializing it.
   */
  it('reports a result that carries no planted value, needles held separately', async () => {
    const control = await runPositiveControl({ retainArtifacts: true });
    try {
      const { plantedNeedles, ...controlReport } = control;
      expect(plantedNeedles).toHaveLength(5);
      const serialized = JSON.stringify(controlReport);
      for (const needle of plantedNeedles) expect(serialized).not.toContain(needle.value);
      expect(serialized).toContain('strict:literal-credential-value');
    } finally {
      fs.rmSync(control.directory, { recursive: true, force: true });
    }
  });
});
