/**
 * Sweep published artifacts for verbatim occurrences of candidate values.
 *
 * The scan is **byte-level and structural-free on the happy path**: every file
 * is streamed through one Aho-Corasick automaton built from the candidate
 * needles, which is a single pass over bytes whether there are one needle or a
 * thousand, and it needs no `JSON.parse` of a 464 MB corpus to answer "does any
 * candidate appear here". Only when a needle does appear is the containing
 * artifact re-read structurally to resolve the exact field path, so the cost of
 * locating a leak is paid once, by the file that leaked.
 *
 * Nothing in this module returns a needle value. A finding is the artifact, the
 * field path and the rule class.
 */
import fs from 'node:fs';
import path from 'node:path';

const CHUNK_BYTES = 1 << 20;
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * A needle shorter than this cannot be evidence of anything: it is a word like
 * `password` or a bare number, and a substring search over hundreds of
 * megabytes of artifacts would match it by coincidence rather than by leak. The
 * extraction still counts those values — the candidate totals must not hide
 * them — and the sweep reports how many it left out, so the omission is a
 * stated rule rather than a silent one.
 */
export const MIN_SWEEP_LENGTH = 8;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Aho-Corasick over the byte alphabet, with one failure link per node and the
 * trie's missing transitions pre-filled. Filling the transitions costs one
 * 256-wide table per node and makes the scan loop a single indexed load, which
 * is what keeps a two-gigabyte sweep affordable.
 */
export function buildNeedleMatcher(needles) {
  const goto = [new Int32Array(256)];
  const fail = [0];
  const outputs = [null];

  for (const needle of needles) {
    const bytes = Buffer.from(needle.value, 'utf8');
    if (bytes.length === 0) continue;
    let state = 0;
    for (const byte of bytes) {
      let next = goto[state][byte];
      if (next === 0) {
        next = goto.length;
        goto.push(new Int32Array(256));
        fail.push(0);
        outputs.push(null);
        goto[state][byte] = next;
      }
      state = next;
    }
    (outputs[state] ??= []).push(needle.id);
  }

  const queue = [];
  for (let byte = 0; byte < 256; byte += 1) {
    const child = goto[0][byte];
    if (child !== 0) queue.push(child);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    const inherited = outputs[fail[node]];
    if (inherited) (outputs[node] ??= []).push(...inherited);
    for (let byte = 0; byte < 256; byte += 1) {
      const child = goto[node][byte];
      if (child !== 0) {
        fail[child] = goto[fail[node]][byte];
        queue.push(child);
      } else {
        goto[node][byte] = goto[fail[node]][byte];
      }
    }
  }

  let state = 0;
  let seen = new Set();
  return {
    /** Feed a chunk. State carries across calls, so a needle split by a chunk boundary is still found. */
    feed(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        state = goto[state][bytes[index]];
        const matched = outputs[state];
        if (matched) for (const id of matched) seen.add(id);
      }
    },
    reset() {
      state = 0;
      seen = new Set();
    },
    matched() {
      return seen;
    },
  };
}

/** Every file under the given roots, in one deterministic order. */
export function listArtifactFiles(roots) {
  const files = new Set();
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) files.add(full);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) visit(root);
  }
  return [...files].sort();
}

async function feedFile(file, matcher) {
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  for await (const chunk of stream) matcher.feed(chunk);
}

/**
 * Scan every file and return only those that contain at least one needle.
 *
 * @param {{ files: string[], needles: {id: number, value: string}[] }} input
 * @returns {Promise<{file: string, needleIds: number[]}[]>}
 */
export async function sweepArtifacts({ files, needles }) {
  const matcher = buildNeedleMatcher(needles);
  const hits = [];
  for (const file of files) {
    matcher.reset();
    await feedFile(file, matcher);
    const matched = [...matcher.matched()].sort((a, b) => a - b);
    if (matched.length > 0) hits.push({ file, needleIds: matched });
  }
  return hits;
}

function isBinary(bytes) {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function walkStrings(value, at, visit) {
  if (typeof value === 'string') {
    visit(value, at);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${at}[${index}]`, visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) walkStrings(child, `${at}.${key}`, visit);
  }
}

/** Line numbers whose bytes contain a needle. Byte-level, so every encoding behaves the same. */
function matchedLines(bytes, matcher) {
  const lines = [];
  let lineNumber = 1;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    matcher.reset();
    matcher.feed(bytes.subarray(start, index));
    for (const needleId of [...matcher.matched()].sort((a, b) => a - b)) {
      lines.push({ fieldPath: `line ${lineNumber}`, needleId });
    }
    lineNumber += 1;
    start = index + 1;
  }
  return lines;
}

/**
 * Resolve the exact location of each matched needle inside one artifact.
 *
 * Structured artifacts are parsed and walked, so the field path is the real
 * JSON path. Anything else reports a line number, or `binary` for a file with
 * no line structure. The parse happens here, on the red path, and never on the
 * sweeping pass.
 *
 * @returns {{fieldPath: string, needleId: number}[]}
 */
export function resolveMatches({ file, needleIds, needles }) {
  const targets = needles.filter((needle) => needleIds.includes(needle.id));
  if (targets.length === 0) return [];
  const matcher = buildNeedleMatcher(targets);
  const matchText = (text) => {
    matcher.reset();
    matcher.feed(Buffer.from(text, 'utf8'));
    return [...matcher.matched()].sort((a, b) => a - b);
  };
  const findings = [];
  const extension = path.extname(file).toLowerCase();
  const structured = extension === '.json' || extension === '.jsonl' || extension === '.ndjson';

  if (structured) {
    const raw = fs.readFileSync(file, 'utf8');
    const rows = extension === '.json' ? [raw] : raw.split('\n').filter((line) => line.trim().length > 0);
    const prefix = (index) => (extension === '.json' ? '$' : `line[${index}]`);
    rows.forEach((row, index) => {
      let parsed;
      try {
        parsed = JSON.parse(row);
      } catch {
        return;
      }
      walkStrings(parsed, prefix(index), (leaf, at) => {
        for (const needleId of matchText(leaf)) findings.push({ fieldPath: at, needleId });
      });
    });
    if (findings.length > 0) return findings;
  }

  const bytes = fs.readFileSync(file);
  if (isBinary(bytes)) {
    matcher.reset();
    matcher.feed(bytes);
    for (const needleId of matcher.matched()) findings.push({ fieldPath: 'binary', needleId });
    return findings;
  }
  const lines = matchedLines(bytes, matcher);
  return [...findings, ...lines];
}
