import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * One build before any test in this project. `package-exports`, `packed-worker-smoke`, and the
 * default batch path all read `dist/`, and `build.mjs` replaces `dist/` wholesale; running that
 * inside a test file raced every parallel reader. Test files therefore never build.
 */
export default function setup(): Promise<void> {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`scanner-cli build failed (${signal ?? String(code)})`));
  });
  return promise;
}
