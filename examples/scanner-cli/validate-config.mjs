import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadExplicitConfig } from '../../packages/scanner-cli/src/v2/config.ts';

const directory = resolve(import.meta.dirname);
const configPath = resolve(directory, 'config.json');
const candidate = readFileSync(configPath, 'utf8');
const result = loadExplicitConfig(candidate, { configDirectory: directory });
if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
}
