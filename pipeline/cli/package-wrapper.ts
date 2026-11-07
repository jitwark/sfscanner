import { parseCliArguments } from 'sfscanner/v2/arguments';
import { runCliV2, type PublicRunOptionsV2, type PublicRunResultV2 } from 'sfscanner/v2/cli-runner';
import { getHelpV2 } from 'sfscanner/v2/help';
import { emitMetadataCommandResultV2 } from 'sfscanner/v2/metadata-output';
import { runCli, type CliRunResult, type CliRunnerOptions } from './cli-runner.js';

export type PipelineCliOptions = Readonly<CliRunnerOptions & PublicRunOptionsV2>;
export type PipelineCliResult = CliRunResult | PublicRunResultV2;

export async function runPipelineCli(argv: readonly string[], options: PipelineCliOptions = {}): Promise<PipelineCliResult> {
  const dispatch = parseCliArguments(argv);

  if (dispatch.mode === 'v1') {
    return runCli(dispatch.argv, {
      cwd: options.cwd,
      stdin: options.stdin,
      signal: options.signal,
    });
  }

  if (!dispatch.result.ok) {
    const detail = dispatch.result.error.argument === undefined
      ? dispatch.result.error.message
      : `${dispatch.result.error.message} (${dispatch.result.error.argument})`;
    return { exitCode: 2, stdout: '', stderr: `Invalid command usage: ${detail}\n` };
  }

  const command = dispatch.result.command;
  if (command.kind === 'help') {
    return { exitCode: 0, stdout: getHelpV2(command.command), stderr: '' };
  }
  if (command.kind === 'scan') {
    return runCliV2(command, { cwd: options.cwd, stdin: options.stdin, signal: options.signal });
  }

  const result = emitMetadataCommandResultV2(command, undefined, {
    configDirectory: options.cwd ?? process.cwd(),
  });
  return result.ok
    ? { exitCode: 0, stdout: result.output, stderr: '' }
    : { exitCode: 2, stdout: '', stderr: `${result.message}\n` };
}
