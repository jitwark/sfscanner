import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = ['synthetic-risky-workflow.json', 'synthetic-safe-workflow.json'];
const forbiddenKey = /credential|password|secret|token|api[_-]?key|authorization/i;
const networkUrl = /\b(?:https?|wss?):\/\//i;

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(value, file, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) {
    if (typeof value === 'string' && networkUrl.test(value)) fail(file, 'network endpoint is not allowed');
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, file, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) fail(file, `credential-like field '${key}' is not allowed`);
    walk(child, file, seen);
  }
}

function validateFixture(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  let workflow;
  try {
    workflow = JSON.parse(text);
  } catch (error) {
    fail(file, `invalid JSON (${error.message})`);
  }
  if (!isRecord(workflow) || typeof workflow.name !== 'string' || !workflow.name.startsWith('Synthetic ')) {
    fail(file, 'fixture must be synthetic');
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 1) fail(file, 'nodes must be non-empty');
  if (!isRecord(workflow.connections)) fail(file, 'connections must be an object');
  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (!isRecord(node) || typeof node.name !== 'string' || typeof node.id !== 'string') fail(file, 'nodes need string name and id');
    if (names.has(node.name) || ids.has(node.id)) fail(file, 'node names and ids must be unique');
    names.add(node.name);
    ids.add(node.id);
  }
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (!names.has(source) || !isRecord(outputs)) fail(file, `connection source '${source}' is unknown`);
    for (const branch of outputs.main ?? []) for (const edge of branch ?? []) {
      if (!isRecord(edge) || typeof edge.node !== 'string' || !names.has(edge.node)) fail(file, 'connection target is unknown');
    }
  }
  walk(workflow, file);
}

for (const fixture of fixtures) validateFixture(fixture);
process.stdout.write(`Validated ${fixtures.length} synthetic workflow fixtures.\n`);
