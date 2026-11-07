import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const prompt = fs.readFileSync(path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt'), 'utf8');

describe('active enrichment prompt contract', () => {
  test('requires JSON-only workflow input and structured layman-friendly output', () => {
    expect(prompt).toMatch(/PROMPT VERSION:\s*describe-6-json-workflow-lexical-check/i);
    expect(prompt).toMatch(/workflow JSON is the only source of truth/i);
    expect(prompt).toMatch(/plain, friendly words/i);
    expect(prompt).toMatch(/450 to 600 words/i);
    expect(prompt).toMatch(/exampleScenario/i);
    expect(prompt).toMatch(/howItWorks/i);
    expect(prompt).toMatch(/website text/i);
    expect(prompt).toMatch(/same ordinal position/i);
  });

  test('requires a final lexical scan before returning model output', () => {
    expect(prompt).toMatch(/MANDATORY FINAL LEXICAL CHECK/i);
    expect(prompt).toMatch(/scan every string in every object/i);
    expect(prompt).toMatch(/forbidden vocabulary includes/i);
  });

  test('does not instruct the model to consume fact packets or upstream prose', () => {
    expect(prompt).not.toMatch(/fact packets/i);
    expect(prompt).not.toMatch(/upstream description/i);
  });
});
