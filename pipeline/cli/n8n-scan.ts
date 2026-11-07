import { runPipelineCli } from './package-wrapper.js';

const controller = new AbortController();
const onSigint = () => controller.abort();
process.once('SIGINT', onSigint);
try {
  const result = await runPipelineCli(process.argv.slice(2), { signal: controller.signal });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} finally {
  process.removeListener('SIGINT', onSigint);
}
