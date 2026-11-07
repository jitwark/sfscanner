import { auditScannerDocs, loadScannerDocs } from './lib/scanner-doc-consistency.mjs';

const result = auditScannerDocs(loadScannerDocs());
if (result.errors.length > 0) {
  console.error(`Scanner documentation parity failed (${result.errors.length} error(s))`);
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Scanner documentation parity passed.');
}
