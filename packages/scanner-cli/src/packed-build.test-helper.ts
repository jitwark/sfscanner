import { cpSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';

/** Build copied workspace sources; only external dependencies/tools link back to the install. */
export function copyPackedBuildWorkspace(workRoot: string, hubRoot: string): string {
  const sourceRoot = path.join(workRoot, 'source');
  const projects = ['contracts', 'packages/scanner-core', 'packages/scanner-cli'];
  const dependencies = new Set(['esbuild', 'typescript']);
  const workspaces = new Map<string, string>();
  mkdirSync(path.join(sourceRoot, 'docs/scanner'), { recursive: true });
  cpSync(path.join(hubRoot, 'docs/scanner/semantic-source-receipts.json'), path.join(sourceRoot, 'docs/scanner/semantic-source-receipts.json'));
  for (const project of projects) {
    const destination = path.join(sourceRoot, project);
    cpSync(path.join(hubRoot, project), destination, { recursive: true,
      filter: (source) => !/(?:^|[/\\])(?:node_modules|dist|\.cache|\.work|\.git)$/u.test(source) });
    const manifest = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8')) as {
      name: string; dependencies?: Record<string, string>;
    };
    workspaces.set(manifest.name, destination);
    for (const name of Object.keys(manifest.dependencies ?? {})) if (!name.startsWith('@hub/')) dependencies.add(name);
  }
  for (const [name, target] of [...workspaces, ...[...dependencies].map((name) => [name, path.join(hubRoot, 'node_modules', name)] as const)]) {
    const link = path.join(sourceRoot, 'node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return path.join(sourceRoot, 'packages/scanner-cli');
}
