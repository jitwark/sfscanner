import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditCliDocs, loadCliDocsInput } from './check-cli-docs.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const GENERAL_HELP = `
Usage:
  n8n-scan scan <file|directory|-> [options]
  n8n-scan rules
  n8n-scan explain <policy-id>
  n8n-scan version [--json]

Options:
  --help     Show this help text.
  --version  Print the CLI version.
`;

const SCAN_HELP = `
Usage:
  n8n-scan scan <file|directory|-> [options]

Options:
  --format <table|json|sarif>
  --output <path>
  --profile <beta-default|beta-hardened>
  --approved-domain <domain>
  --fail-on <severity>
  --max-concurrency <positive-int>
  --timeout <positive-int>
  --include <glob>
  --exclude <glob>
  --no-color
  --quiet
  --help
`;

const CONTRACT_SOURCE = `
export const CLI_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FINDINGS: 1,
  USAGE: 2,
  INPUT: 3,
  INTERNAL: 4,
  CANCELLED: 130,
} as const);
`;

const COMPLETE_DOCS = `
<!-- cli-docs:surface -->
### Commands
| Command | Description |
| --- | --- |
| \`scan\` | Scan workflows. |
| \`rules\` | List rules. |
| \`explain\` | Explain a rule. |
| \`version\` | Print versions. |

### Options
| Option | Description |
| --- | --- |
| \`--help\` | Show help. |
| \`--version\` | Print the CLI version. |
| \`--json\` | Emit JSON version metadata. |
| \`--format\` | Select output format. |
| \`--output\` | Write output. |
| \`--profile\` | Select profile. |
| \`--approved-domain\` | Approve a domain. |
| \`--fail-on\` | Set the finding threshold. |
| \`--max-concurrency\` | Bound concurrency. |
| \`--timeout\` | Set the timeout. |
| \`--include\` | Include paths. |
| \`--exclude\` | Exclude paths. |
| \`--no-color\` | Disable color. |
| \`--quiet\` | Suppress diagnostics. |

### Exit codes
| Code | Meaning |
| --- | --- |
| \`0\` | Complete. |
| \`1\` | Findings. |
| \`2\` | Usage failure. |
| \`3\` | Input failure. |
| \`4\` | Internal failure. |
| \`130\` | Interrupted. |
<!-- /cli-docs:surface -->
`;

const input = (docs = COMPLETE_DOCS) => ({
  docs,
  generalHelp: GENERAL_HELP,
  scanHelp: SCAN_HELP,
  contractSource: CONTRACT_SOURCE,
});


const v2Input = (v2Docs = readFileSync(resolve(ROOT, 'docs/scanner/cli-v2.md'), 'utf8')) => ({
  ...input(),
  v2Docs,
  v2HelpSource: readFileSync(resolve(ROOT, 'packages/scanner-cli/src/v2/help.ts'), 'utf8'),
  v2ArgumentsSource: readFileSync(resolve(ROOT, 'packages/scanner-cli/src/v2/arguments.ts'), 'utf8'),
  v2ExitSource: readFileSync(resolve(ROOT, 'packages/scanner-cli/src/v2/exit-reducer.ts'), 'utf8'),
});
describe('CLI documentation consistency gate', () => {
  it('loads docs input through the admitted v2 JSON metadata command', () => {
    expect(() => loadCliDocsInput(ROOT)).not.toThrow();
  });
  it('accepts documentation that matches the local help and exit-code definitions', () => {
    expect(auditCliDocs(input()).errors).toEqual([]);
  });

  it('reports missing supported documentation and invented surface entries', () => {
    const docs = COMPLETE_DOCS
      .replace('| `--timeout` | Set the timeout. |\n', '')
      .replace('| `--quiet` | Suppress diagnostics. |', '| `--publish` | Publish remotely. |')
      .replace('| `130` | Interrupted. |', '| `999` | Made up. |')
      .replace('| `version` | Print versions. |', '| `publish` | Publish remotely. |');

    expect(auditCliDocs(input(docs)).errors).toEqual(expect.arrayContaining([
      'documentation is missing supported option: --timeout',
      'documentation has unsupported option: --publish',
      'documentation is missing supported exit code: 130',
      'documentation has unsupported exit code: 999',
      'documentation is missing supported command: version',
      'documentation has unsupported command: publish',
    ]));
  });

  it('fails when the auditable documentation surface is missing', () => {
    expect(auditCliDocs(input('The CLI is experimental.')).errors).toContain(
      'documentation is missing the cli-docs:surface block',
    );
  });

  it('rejects unsupported commands and options claimed outside the reference table', () => {
    const docs = `${COMPLETE_DOCS}\nUse \`n8n-scan publish --remote\` to publish.\n`;

    expect(auditCliDocs(input(docs)).errors).toEqual(expect.arrayContaining([
      'documentation has unsupported command: publish',
      'documentation has unsupported option: --remote',
    ]));
  });

  it('accepts the v2 marker only when it matches parser and reducer authorities', () => {
    expect(auditCliDocs(v2Input()).errors).toEqual([]);
  });

  it('rejects unsupported v2 marker vocabulary and missing canonical claims', () => {
    const docs = v2Input().v2Docs
      .replace('| `--no-color` | Disable color in human output. |', '| `--future` | Unsupported. |')
      .replace('Published on npm as sfscanner.', 'The package status is not stated.');
    expect(auditCliDocs({ ...v2Input(docs), v2Docs: docs }).errors).toEqual(expect.arrayContaining([
      'documentation is missing supported option: --no-color',
      'documentation has unsupported option: --future',
      'v2 documentation is missing canonical claim: Published on npm as sfscanner.',
    ]));
  });
  it('ignores wrapper flags while still rejecting unsupported n8n-scan options', () => {
    const clean = auditCliDocs(v2Input()).errors;
    expect(clean).not.toContain('documentation has unsupported option: --no-install');
    const docs = `${v2Input().v2Docs}\nUse \`n8n-scan scan workflow.json --future\` for a scan.\n`;
    expect(auditCliDocs({ ...v2Input(docs), v2Docs: docs }).errors).toContain('documentation has unsupported option: --future');
  });
});
