import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirectoryBestEffort, fsyncFile } from './fsync.js';

export type AtomicFileWriter = (temporaryPath: string) => void;

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertRegularFile(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Atomic export ${label} is missing`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Atomic export ${label} must be a regular file`);
}

function replaceFile(temporaryPath: string, outputPath: string, stagingDirectory: string): void {
  const previousPath = path.join(stagingDirectory, 'previous');
  let previousMoved = false;
  if (pathExists(outputPath)) {
    assertRegularFile(outputPath, 'target');
    fs.renameSync(outputPath, previousPath);
    previousMoved = true;
  }
  try {
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (previousMoved && fs.existsSync(previousPath)) fs.renameSync(previousPath, outputPath);
    throw error;
  }
  if (previousMoved) fs.rmSync(previousPath, { force: true });
}

/** Write a complete artifact to a sibling staging directory, then replace the exact target. */
export function writeAtomicFileWithWriter(outputPath: string, writer: AtomicFileWriter): void {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(directory, `.${path.basename(outputPath)}.tmp-`));
  const temporaryPath = path.join(stagingDirectory, path.basename(outputPath));
  try {
    writer(temporaryPath);
    if (!fs.existsSync(temporaryPath)) throw new Error('Atomic export writer did not create an output file');
    assertRegularFile(temporaryPath, 'writer output');
    fsyncFile(temporaryPath);
    replaceFile(temporaryPath, outputPath, stagingDirectory);
    fsyncDirectoryBestEffort(directory);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export function writeAtomicFile(outputPath: string, content: string | Uint8Array): void {
  writeAtomicFileWithWriter(outputPath, (temporaryPath) => fs.writeFileSync(temporaryPath, content));
}
