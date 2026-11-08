import { cpSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';

type PackageManifest = Readonly<{ dependencies?: Readonly<Record<string, string>> }>;

function addInstalledClosure(hubRoot: string, names: readonly string[], installed: Map<string, string>): void {
  for (const name of names) {
    if (installed.has(name)) continue;
    const packageRoot = path.join(hubRoot, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;
    installed.set(name, packageRoot);
    addInstalledClosure(hubRoot, Object.keys(manifest.dependencies ?? {}), installed);
  }
}

/** Build copied workspace sources; only external dependencies/tools link back to the install. */
export function copyPackedBuildWorkspace(workRoot: string, hubRoot: string): string {
  const sourceRoot = path.join(workRoot, 'source');
  const projects = ['contracts', 'packages/scanner-core', 'packages/scanner-cli'];
  const dependencies = new Map<string, string>([
    ['esbuild', path.join(hubRoot, 'node_modules', 'esbuild')],
    ['typescript', path.join(hubRoot, 'node_modules', 'typescript')],
  ]);
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
    for (const name of Object.keys(manifest.dependencies ?? {})) if (!name.startsWith('@hub/')) dependencies.set(name, path.join(hubRoot, 'node_modules', name));
  }
  addInstalledClosure(hubRoot, ['@types/node'], dependencies);
  for (const [name, target] of [...workspaces, ...dependencies]) {
    const link = path.join(sourceRoot, 'node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return path.join(sourceRoot, 'packages/scanner-cli');
}
