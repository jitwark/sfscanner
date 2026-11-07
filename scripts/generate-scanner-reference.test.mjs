import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_DOCS,
  loadScannerReferenceSources,
  renderScannerReference,
} from './lib/scanner-reference-generators.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('scanner reference source model', () => {
  it('reads every required runtime source and derives non-empty authoritative surfaces', () => {
    const model = loadScannerReferenceSources(ROOT);
    expect(Object.keys(model.docs)).toEqual(GENERATED_DOCS);
    expect(model.rules.length).toBeGreaterThan(0);
    expect(model.diagnostics.length).toBeGreaterThan(0);
    expect(model.limits.fields).toContain('maxBytes');
    expect(model.schemas.length).toBeGreaterThan(0);
    expect(model.cli.commands).toContain('scan');
    expect(model.cli.options).toContain('--profile');
    expect(model.cli.exitCodes).toContain(130);
    expect(model.examples.length).toBeGreaterThan(0);
  });

  it('renders the same bytes for the same sources and never emits CRLF', () => {
    const model = loadScannerReferenceSources(ROOT);
    const first = renderScannerReference(model);
    const second = renderScannerReference(model);
    expect(first).toEqual(second);
    for (const content of Object.values(first)) {
      expect(content).toMatch(/\n$/);
      expect(content).not.toContain('\r');
      expect(content).toContain('DO NOT EDIT');
    }
  });

  it('fails closed when a required source is missing', () => {
    expect(() => loadScannerReferenceSources(resolve(ROOT, 'missing-root'))).toThrow(/source/i);
  });

  it('does not copy private machine paths or secret-like values into output', () => {
    const model = loadScannerReferenceSources(ROOT);
    const rendered = Object.values(renderScannerReference(model)).join('\n');
    expect(rendered).not.toMatch(/[A-Z]:\\Users\\/i);
    expect(rendered).not.toMatch(/(?:password|secret|token)\s*[:=]\s*['"][^'"]+/i);
  });
});
