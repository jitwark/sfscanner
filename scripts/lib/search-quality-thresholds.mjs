import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const thresholdNames = ['SEARCH_QUALITY_MIN_RECALL', 'SEARCH_QUALITY_MIN_NDCG'];

export function loadSearchQualityThresholds(filePath = resolve(root, 'docs/search-quality-thresholds.json')) {
  let config;
  try {
    config = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Search quality threshold config could not be read: ${error.message}`);
  }
  if (config?.schemaVersion !== 'search-quality-thresholds-v1' || config?.status !== 'provisional') {
    throw new Error('Search quality threshold config has an unsupported schema or status');
  }
  const thresholds = Object.fromEntries(thresholdNames.map((name) => [name, config[name]]));
  for (const [name, value] of Object.entries(thresholds)) {
    if (typeof value !== 'string' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
      throw new Error(`${name} must be a string containing a number between 0 and 1`);
    }
  }
  return thresholds;
}
