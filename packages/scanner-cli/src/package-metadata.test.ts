import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

describe('published sfscanner metadata', () => {
  it('exposes the requested package identity and binaries', () => {
    expect(packageJson.name).toBe('sfscanner');
    expect(packageJson.description).toBe('SecureFlow Scanner — Deterministic, offline security & dataflow analyzer for n8n workflows');
    expect(packageJson.private).toBe(false);
    // The manifest keeps the bin targets as its author wrote them (no `./` prefix); npm normalizes the
    // optional `./` to one form when it packs, so the source punctuation is npm's to own (E3-report.md).
    expect(packageJson.bin).toEqual({ sfscanner: 'dist/main.js', 'sfscanner-mcp': 'dist/mcp.js' });
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.repository.url).toBe('git+https://github.com/jitwark/sfscanner.git');
  });
});
