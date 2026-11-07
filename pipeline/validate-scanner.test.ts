import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./validate-scanner.ts', import.meta.url), 'utf8');

describe('scanner corpus validator dependencies', () => {
  it('uses scanner-core parsing and the pipeline scanner-core adapter', () => {
    expect(source).toMatch(/import \{ parseWorkflowJson \} from '@hub\/scanner-core\/workflow';/);
    expect(source).toMatch(/import \{ scanWorkflowWithCore \} from '\.\/scan\/scanner-core-adapter\.js';/);
    expect(source).toContain('scanWorkflowWithCore(parsed.workflow');
    expect(source).not.toMatch(/from '\.\.\/app\/src\/(?:workflow\/workflow|scanner\/engine)\.js'/);
  });
});
