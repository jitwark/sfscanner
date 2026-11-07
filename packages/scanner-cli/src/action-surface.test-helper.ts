import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareActionFixture(root: string, workspace: string, authority: string, workflows: Record<string, string>) {
  const source = path.join(workspace, '.scanner-source');
  const cli = path.join(source, 'packages/scanner-cli');
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
  cpSync(path.join(root, 'packages/scanner-cli/dist'), path.join(cli, 'dist'), { recursive: true });
  cpSync(path.join(root, 'packages/scanner-cli/package.json'), path.join(cli, 'package.json'));
  for (const file of ['run-scan.mjs', 'preflight.mjs', 'adapter.mjs', 'artifact-digest.mjs', 'release-contract.mjs']) {
    cpSync(path.join(root, 'scripts/scanner-action', file), path.join(authority, file));
  }
  for (const [name, body] of Object.entries(workflows)) {
    mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    writeFileSync(path.join(workspace, name), body);
  }
  writeActionReceipt(root, workspace, authority);
}

/** Only synthetic test authority is populated; the checked-in production policy is untouched. */
export function writeActionReceipt(root: string, workspace: string, authority: string, scannerRef?: string) {
  const vector = JSON.parse(readFileSync(path.join(root, 'scripts/scanner-action/receipt-vectors.json'), 'utf8'));
  const script = `
    import fs from 'node:fs';
    import { collectArtifactEntries } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/scanner-action/artifact-digest.mjs')).href)};
    import { sha256Bytes } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/scanner-action/release-contract.mjs')).href)};
    const receipt = { ...${JSON.stringify(vector.receipt)}, ...collectArtifactEntries(${JSON.stringify(path.join(workspace, '.scanner-source'))}),
      ...${JSON.stringify(scannerRef === undefined ? {} : { scannerRef })} };
    const bytes = JSON.stringify(receipt);
    fs.writeFileSync(${JSON.stringify(path.join(authority, 'release-receipt.json'))}, bytes);
    fs.writeFileSync(${JSON.stringify(path.join(authority, 'release-policy.json'))}, JSON.stringify({ ...${JSON.stringify(vector.policy)}, releaseReceiptSha256: sha256Bytes(bytes) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}
