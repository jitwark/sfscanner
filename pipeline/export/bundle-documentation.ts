import { relationNames, dictionaryRows, isV4, type ExportProjection } from './export-version.js';
import path from 'node:path';
import { writeAtomicFile } from './atomic-file.js';

export type PublicReleaseDocumentation = {
  schemaPath: string;
  dictionaryPath: string;
  releaseNotesPath: string;
  examplePath: string;
};

export const DOCUMENTATION_PATHS: PublicReleaseDocumentation = {
  schemaPath: 'schema.json',
  dictionaryPath: 'data-dictionary.json',
  releaseNotesPath: 'release-notes.md',
  examplePath: 'examples.json',
};

export function writeSchemaDocument(projection: ExportProjection, outputDir: string): void {
  const dictionary = dictionaryRows(projection);
  const fields = Object.fromEntries(relationNames(projection).map((relation) => [
    relation,
    dictionary.filter((row) => row.relation === relation).map((row) => row.field),
  ]));
  writeAtomicFile(path.join(outputDir, DOCUMENTATION_PATHS.schemaPath), `${JSON.stringify({ schemaVersion: projection.schemaVersion, releaseId: projection.release.releaseId, relations: fields })}\n`);
}

export function writeDataDictionaryDocument(projection: ExportProjection, outputDir: string): void {
  writeAtomicFile(path.join(outputDir, DOCUMENTATION_PATHS.dictionaryPath), `${JSON.stringify({ schemaVersion: projection.schemaVersion, fields: dictionaryRows(projection) })}\n`);
}

export function writeReleaseNotesDocument(projection: ExportProjection, outputDir: string): void {
  writeAtomicFile(path.join(outputDir, DOCUMENTATION_PATHS.releaseNotesPath), `# Public data release ${projection.release.releaseId}\n\nSchema: ${projection.schemaVersion}\nGenerated: ${projection.release.generatedAt}\n\nThis release is generated from one rights-aware canonical projection. Workflow bodies are referenced only when redistribution is authorized; scanner descriptions and remediation prose are not execution guarantees.\n\nThe \`credentials\` relation lists the distinct credential types this release references, deduplicated; \`requirements\` rows with \`kind = credential\` are those same references at workflow grain, so the two cannot disagree about presence. A credentials count of zero means no credential reference was recorded — it is not a statement that the workflows need none to run.\n\nA \`requirements.status\` of \`unknown\` means the value was not established by a scan of an authorized body: version notes always read that way, and so does every domain, replaceable-value and community-node value of a row whose \`readiness.analysis\` is \`unscanned\`. Those rows keep their historically derived values rather than losing them, so read \`unknown\` as unconfirmed, not as satisfied.\n\nAn Excel cell holds at most 32,767 characters. The complete value is always present in the NDJSON and SQLite artifacts; any cell the workbook clipped is counted, with its field, in \`formats.excel.truncation\` of \`public-release.json\` and on the workbook's Release Metadata sheet.\n\nExclusions and artifacts are schema-reserved relations. No public per-entry exclusion or artifact registry is populated or projected here: the upstream acquisition exclusion list drops candidates before they become entries, and artifact identity lives in this bundle’s public-release.json manifest. A nonzero excluded count in counts or facetCounts.rights is a corpus facet, not a row count.\n${isV4(projection) ? '\nV4 legacy credential/community reference counts are retained with category labels and public ordinals; original tokens and their hashes are withheld. The source-bound prerequisite inventory is preflightCoverage/preflightEvidence. Unknown live facts remain UNKNOWN.\n' : ''}`);
}

export function writeExamplesDocument(projection: ExportProjection, outputDir: string): void {
  writeAtomicFile(path.join(outputDir, DOCUMENTATION_PATHS.examplePath), `${JSON.stringify({ schemaVersion: projection.schemaVersion, releaseId: projection.release.releaseId, workflows: projection.workflows.slice(0, 3) })}\n`);
}
