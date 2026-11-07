/**
 * Positive control for the published-secret gate.
 *
 * A leak gate that has only ever passed is not evidence. This plants one
 * synthetic value per rule class into a synthetic raw body and a temporary
 * artifact, then runs the **real** extractor and the **real** sweep over them,
 * so what is proven is the production path and not a stub:
 *
 *   synthetic body → collectCandidates → planted needles → temp artifact → sweepArtifacts
 *
 * The planted values are derived deterministically from a fixed seed over an
 * alphabet that cannot spell a placeholder word, so the control is reproducible
 * and cannot be filtered out by the extractor's own rules. They are synthetic,
 * never drawn from the corpus, and the temporary artifact is removed in a
 * `finally` — but nothing here ever reports a planted value either, because the
 * gate's own output must not be a place a value can appear.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectCandidates,
  createCandidateIndex,
  isLiteralValue,
  partitionCandidates,
  STRICT_RULES,
  LOOSE_RULE,
} from './published-secret-candidates.mjs';
import { resolveMatches, sweepArtifacts } from './published-secret-sweep.mjs';

const CONTROL_SEED = 'published-secret-gate/positive-control/v1';

/**
 * Every placeholder word the extractor knows contains a letter outside this
 * alphabet, so a value built from it can never be mistaken for an example, and
 * it cannot spell an n8n expression either.
 */
const PLANT_ALPHABET = 'bjqvwxz0123456789';

function plantable(label, length) {
  const digest = createHash('sha256').update(`${CONTROL_SEED}:${label}`).digest('hex');
  let value = 'pc';
  for (const character of digest) {
    if (value.length >= length + 2) break;
    value += PLANT_ALPHABET[Number.parseInt(character, 16) % PLANT_ALPHABET.length];
  }
  if (!isLiteralValue(value)) throw new Error('Positive control produced a value the extractor would reject');
  return value;
}

/** A raw body shaped like the ones the corpus carries, with one plant per rule class. */
function buildControlBody() {
  const planted = {
    basic: `Basic ${plantable('basic', 28)}`,
    bearer: `Bearer ${plantable('bearer', 34)}`,
    credentialUser: plantable('credential-user', 18),
    credentialPassword: plantable('credential-password', 22),
    looseOnly: plantable('loose-only', 26),
  };
  const body = {
    nodes: [
      {
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        parameters: {
          headerParameters: {
            parameters: [
              { name: 'Authorization', value: planted.basic },
              { name: 'Authorization', value: planted.bearer },
              { name: 'X-Api-Key', value: planted.looseOnly },
            ],
          },
        },
        credentials: {
          httpBasicAuth: { id: 'pc-credential', name: 'PC Credential', user: planted.credentialUser, password: planted.credentialPassword },
        },
      },
    ],
    connections: {},
  };
  return { body, planted };
}

const EXPECTED = Object.freeze({
  strict: [STRICT_RULES.BASIC_HEADER, STRICT_RULES.BEARER_HEADER, STRICT_RULES.CREDENTIAL_VALUE],
  loose: [LOOSE_RULE],
});

/**
 * The artifact the plants are written into. Its shape mirrors a published
 * catalogue entry closely enough that the structural resolver has to do real
 * work, and the expected paths are asserted exactly.
 */
function buildControlArtifact(planted) {
  const artifact = {
    nodes: [
      {
        parameters: {
          headerParameters: {
            parameters: [
              { name: 'Authorization', value: planted.basic },
              { name: 'Authorization', value: planted.bearer },
              { name: 'X-Api-Key', value: planted.looseOnly },
            ],
          },
        },
        credentials: { httpBasicAuth: { user: planted.credentialUser, password: planted.credentialPassword } },
      },
    ],
  };
  const paths = [
    '$.nodes[0].parameters.headerParameters.parameters[0].value',
    '$.nodes[0].parameters.headerParameters.parameters[1].value',
    '$.nodes[0].parameters.headerParameters.parameters[2].value',
    '$.nodes[0].credentials.httpBasicAuth.user',
    '$.nodes[0].credentials.httpBasicAuth.password',
  ];
  return { artifact, paths };
}

/**
 * Run the control.
 *
 * @param {{retainArtifacts?: boolean}} [options] `retainArtifacts` keeps the temporary
 *   directory alive and returns its files, which is what `--plant-leak` needs to show the
 *   gate failing. The caller then owns removing `directory`.
 * @returns {Promise<{plantedValues: number, detectedValues: number, strictClasses: string[], looseClasses: string[], fieldPaths: string[], lineArtifactDetected: boolean, directory?: string, artifactFiles?: string[]}>}
 */
export async function runPositiveControl(options = {}) {
  const { body, planted } = buildControlBody();
  const index = collectCandidates(body, 'positive-control.json', createCandidateIndex());
  const { strict } = partitionCandidates(index);
  const seenRules = new Set([...index.values()].flatMap((entry) => [...entry.rules]));
  const missing = [...EXPECTED.strict, ...EXPECTED.loose].filter((rule) => !seenRules.has(rule));
  if (missing.length > 0) {
    throw new Error(`Positive control failed extraction for: ${missing.join(', ')}`);
  }
  if (strict.length === 0) throw new Error('Positive control failed: no strict candidate extracted');

  const needles = [...index.values()].map((entry, id) => ({
    id,
    value: entry.value,
    strictRules: [...entry.rules].filter((rule) => rule !== LOOSE_RULE).sort(),
    fieldPaths: [...entry.fieldPaths].sort(),
    sources: [...entry.sources].sort(),
  }));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-secret-gate-control-'));
  try {
    const { artifact, paths } = buildControlArtifact(planted);
    const jsonPath = path.join(directory, 'control-artifact.json');
    fs.writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const htmlPath = path.join(directory, 'control-artifact.html');
    fs.writeFileSync(htmlPath, `<html><body>\n<!-- inert -->\n<x>${planted.looseOnly}</x>\n</body></html>\n`, 'utf8');

    const hits = await sweepArtifacts({ files: [jsonPath, htmlPath], needles });
    const jsonHit = hits.find((hit) => hit.file === jsonPath);
    const htmlHit = hits.find((hit) => hit.file === htmlPath);
    if (!jsonHit) throw new Error('Positive control failed: the sweep did not detect the planted artifact');
    if (jsonHit.needleIds.length !== needles.length) {
      throw new Error(`Positive control failed: sweep detected ${jsonHit.needleIds.length} of ${needles.length} planted values`);
    }

    const resolved = resolveMatches({ file: jsonPath, needleIds: jsonHit.needleIds, needles });
    const resolvedPaths = new Set(resolved.map((finding) => finding.fieldPath));
    const unresolved = paths.filter((expected) => !resolvedPaths.has(expected));
    if (unresolved.length > 0) {
      throw new Error(`Positive control failed: no field path resolved for ${unresolved.length} planted value(s)`);
    }

    const resolvedRules = new Set(
      resolved.flatMap((finding) => needles[finding.needleId]?.strictRules ?? []),
    );
    const unresolvedRules = EXPECTED.strict.filter((rule) => !resolvedRules.has(rule));
    if (unresolvedRules.length > 0) {
      throw new Error(`Positive control failed: no detection reported for rule class(es) ${unresolvedRules.join(', ')}`);
    }

    const htmlResolved = htmlHit
      ? resolveMatches({ file: htmlPath, needleIds: htmlHit.needleIds, needles })
      : [];
    const linePathResolved = htmlResolved.some((finding) => /^line \d+$/.test(finding.fieldPath));

    return {
      plantedValues: needles.length,
      detectedValues: jsonHit.needleIds.length,
      strictClasses: [...resolvedRules].sort(),
      looseClasses: [...EXPECTED.loose],
      fieldPaths: [...resolvedPaths].sort(),
      lineArtifactDetected: Boolean(htmlHit) && linePathResolved,
      ...(options.retainArtifacts ? { directory, artifactFiles: [jsonPath, htmlPath], plantedNeedles: needles } : {}),
    };
  } finally {
    if (!options.retainArtifacts) fs.rmSync(directory, { recursive: true, force: true });
  }
}
