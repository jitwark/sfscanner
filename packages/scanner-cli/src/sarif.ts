import { buildSarifDocument, type SarifNotification } from '@hub/scanner-core/report/sarif-document';
import { CLI_VERSION, type ScanDocument } from './scan.js';

const TOOL_NAME = 'n8n-scan';
const INFORMATION_URI = 'https://github.com/jitwark/n8n-Secureflow';

/**
 * SARIF for the standalone package: one input, so there is no batch to sort
 * and at most one notification. Document assembly (rules, CWE tags, sorted
 * results) is shared with the pipeline-workspace CLI through
 * @hub/scanner-core/report/sarif-document — see that module's header comment
 * for why the two agree on shape and the browser report does not.
 */
export function toSarifDocument(document: ScanDocument): Record<string, unknown> {
  if (!document.ok) {
    return buildSarifDocument({
      toolName: TOOL_NAME,
      toolVersion: CLI_VERSION,
      informationUri: INFORMATION_URI,
      findings: [],
      notifications: [errorNotification(document)],
      executionSuccessful: false,
    });
  }

  return buildSarifDocument({
    toolName: TOOL_NAME,
    toolVersion: CLI_VERSION,
    informationUri: INFORMATION_URI,
    findings: document.findings.map((finding) => ({ input: document.input, finding })),
    executionSuccessful: true,
  });
}

function errorNotification(document: Extract<ScanDocument, { ok: false }>): SarifNotification {
  return {
    descriptor: { id: document.error.code },
    message: { text: `${document.input}: ${document.error.message}` },
    properties: { input: document.input, code: document.error.code },
  };
}
