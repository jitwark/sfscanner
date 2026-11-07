import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive, verifyArchive } from './pages-release-tar.mjs';
import { downloadRelease } from './pages-release-download.mjs';
import { readReadbackManifest, verifyAnonymousReadback, writeReadbackManifest } from './pages-release-readback.mjs';
import { fail } from './pages-release-paths.mjs';

export async function pagesRelease(argv) {
  const [command, ...flags] = argv;
  const allowed = { create: ['source', 'archive'], verify: ['archive', 'sha256'],
    extract: ['archive', 'sha256', 'destination'], download: ['repository', 'tag', 'asset', 'sha256', 'archive'],
    manifest: ['source', 'output', 'sha256'], readback: ['page-url', 'manifest', 'sha256'] }[command];
  if (!allowed || flags.length !== allowed.length * 2) fail('invalid command or missing arguments');
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index].slice(2), value = flags[index + 1];
    if (!flags[index].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key) || !value) fail('invalid or duplicate argument');
    options[key] = value;
  }
  if (command === 'create') return createArchive(options.source, options.archive);
  if (!/^[a-f0-9]{64}$/u.test(options.sha256)) fail('exact lowercase SHA256 is required');
  if (command === 'download') return downloadRelease(options);
  if (command === 'manifest') return writeReadbackManifest(options.source, options.output, options.sha256);
  if (command === 'readback') return verifyAnonymousReadback({
    pageUrl: options['page-url'],
    manifest: await readReadbackManifest(options.manifest, options.sha256),
  });
  return verifyArchive(options.archive, options.sha256, command === 'extract' ? options.destination : undefined);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await pagesRelease(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
