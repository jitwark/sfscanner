import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/audit-gemini-input.mjs <packet.json>');
  process.exit(1);
}

const rootProhibitedKeys = new Set([
  'description', 'summary', 'name', 'id', 'meta', 'source', 'rights', 'permalink',
  'upstreamDescription', 'descriptionProvenance',
]);
const prohibitedKeys = new Set([
  'credentials', 'pinData', 'binary', 'executionId', 'instanceId', 'versionId',
  'jsCode', 'pythonCode', 'functionCode', 'functionItemCode', 'code',
]);
const secret = /(?:sk-(?:proj|ant)-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|Bearer\s+\S+|AKIA[0-9A-Z]{16}|https?:\/\/[^\s:@]+:[^\s:@]+@)/i;
const packet = JSON.parse(await readFile(file, 'utf8'));
const errors = [];
if (!Array.isArray(packet)) errors.push('packet must be an array');

function walk(value, path, atRoot = false) {
  if (typeof value === 'string') {
    if (secret.test(value)) errors.push(`${path}: secret-like value`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((child, index) => walk(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((atRoot && rootProhibitedKeys.has(key)) || prohibitedKeys.has(key)) errors.push(`${path}.${key}: prohibited field`);
    if (/^(?:api[_-]?key|secret|password|passwd|pass|token|bearer|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|webhook[_-]?secret)$/i.test(key) && child !== '<redacted>') errors.push(`${path}.${key}: sensitive key must be redacted`);
    walk(child, `${path}.${key}`);
  }
}
if (Array.isArray(packet)) packet.forEach((workflow, index) => walk(workflow, `workflows[${index}]`, true));
if (errors.length) {
  console.error(`Gemini input audit failed (${errors.length} issue(s))`);
  console.error(errors.slice(0, 50).join('\n'));
  process.exit(1);
}
console.log(`Gemini input audit passed: ${packet.length} workflow JSON object(s).`);
