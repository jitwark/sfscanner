#!/usr/bin/env node
import { loadReviewedFixSuggestions, type ReviewedFixSuggestionArtifactV1 } from '@hub/scanner-core/remediation/fix-suggestion-artifact';
import { runCli } from './cli.js';
import { parseCliArguments, type CliFixCommandV2 } from './v2/arguments.js';
import { emitMetadataCommandResultV2 } from './v2/metadata-output.js';
import { getHelpV2 } from './v2/help.js';
import { readInputBytes } from './v2/input-read.js';
import { runCliV2 } from './v2/cli-runner.js';
import { runFixCommandV2 } from './v2/fix-command.js';

/**
 * Reviewed shipping data, not a scan result. The entry is keyed by the exact bytes of the fixture
 * recorded in `fix-suggestion-artifact.test.ts` (`reviewed-fixture`, one HTTP Request 4.2 with the
 * literal `http://insecure.example.com` URL); its source, workflow and node digests were produced
 * once by the bounded parser/normalizer. The reviewed finding ID is the `UNAPPROVED_DOMAIN`
 * finding emitted by one authoring scan of those bytes with `approvedDomains: ['trusted.example']`
 * (that scan did not change the source/workflow/node digests). At runtime the loader only
 * recomputes the source/workflow digests and looks the entry up.
 */
const REVIEWED_FIX_SUGGESTIONS: ReviewedFixSuggestionArtifactV1 = Object.freeze({
  schemaVersion: 'reviewed-fix-suggestions-v1',
  version: '1.0.0',
  entries: Object.freeze([
    Object.freeze({
      sourceSha256: '84b6257de1ec8d086e21288e41bd2f5c012cbe6d862171ce823e1bfa6cf12a7b',
      workflowDigest: 'b5f25698aec85a55554275ce4b1879a06a93624d2c58386504f225a8807573a6',
      suggestions: Object.freeze([
        Object.freeze({
          id: 'fix-reviewed-http-insecure-example',
          findingIds: Object.freeze(['49dade28807ba74aac5165e46e2944d74f4bb3f4339cab1958ff21c6f92f2aed']),
          sourceSha256: '84b6257de1ec8d086e21288e41bd2f5c012cbe6d862171ce823e1bfa6cf12a7b',
          workflowDigest: 'b5f25698aec85a55554275ce4b1879a06a93624d2c58386504f225a8807573a6',
          targetVersion: Object.freeze({
            packageName: 'n8n-nodes-base.httpRequest',
            version: '4.2.0',
            inventoryDigest: '26728f7db41960ef0fee9b3fdc67158db3d268e17bd4683c017fd733c3772ba7',
          }),
          resource: Object.freeze({
            kind: 'NODE_PARAMETER',
            nodeIdentityDigest: '2c42f43bc370403fb86c432041ab7828d39c6552281a16ee04ca77ffe649b518',
            pointer: '/nodes/0/parameters/url',
          }),
          templateId: 'REMOVE_INSECURE_OVERRIDE',
          rationaleId: 'REMOVE_INSECURE_OVERRIDE',
          prerequisites: Object.freeze(['USER_CONFIRMATION']),
        }),
      ]),
    }),
  ]),
});

const dispatch = parseCliArguments(process.argv.slice(2));

/**
 * Reads the declared input through the bounded reader, then looks up reviewed suggestions for
 * those exact bytes. No scan runs here: an unreadable input or unmatched digest yields an empty
 * catalogue, and the planner still re-reads and re-plans the source before any write.
 */
async function productionSuggestions(command: CliFixCommandV2) {
  // Standard input cannot be re-read, so the planner refuses it; consuming it here would only
  // steal the bytes the caller meant for another command.
  if (command.input === '-') return [];
  const read = await readInputBytes(command.input, { baseDirectory: command.root });
  if (!read.ok) return [];
  return loadReviewedFixSuggestions(REVIEWED_FIX_SUGGESTIONS, read.bytes);
}

if (dispatch.mode === 'v1') {
  const result = await runCli(dispatch.argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} else if (!dispatch.result.ok) {
  const detail = dispatch.result.error.argument === undefined ? dispatch.result.error.message : `${dispatch.result.error.message} (${dispatch.result.error.argument})`;
  process.stderr.write(`Invalid command usage: ${detail}\n`);
  process.exitCode = 2;
} else if (dispatch.result.command.kind === 'help') {
  process.stdout.write(getHelpV2(dispatch.result.command.command));
  process.exitCode = 0;
} else if (dispatch.result.command.kind === 'fix') {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  try {
    const result = await runFixCommandV2(dispatch.result.command, { signal: controller.signal }, { suggestions: productionSuggestions });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
} else if (dispatch.result.command.kind === 'scan') {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  try {
    const result = await runCliV2(dispatch.result.command, { signal: controller.signal });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
} else {
  const result = emitMetadataCommandResultV2(dispatch.result.command, undefined, { configDirectory: process.cwd() });
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(result.output);
    process.exitCode = 0;
  }
}
