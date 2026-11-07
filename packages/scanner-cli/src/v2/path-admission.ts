import { posix, win32 } from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f]/u;
const SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const DRIVE = /^[a-z]:\//iu;
const MAX_PATH = 4096;

/** Normalizes backslashes before classifying, so a Windows drive path is absolute in both forms. */
export function isAbsoluteAdmittedPathV2(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('//')) return false; // UNC and protocol-relative are not local absolutes
  return normalized.startsWith('/') || DRIVE.test(normalized);
}

export function isAdmittedLocalPath(value: unknown): value is string {
  return admitLocal(value, false) !== undefined;
}

export function isAdmittedRelativePath(value: unknown): value is string {
  return admitLocal(value, true) !== undefined;
}

export function normalizeAdmittedPathV2(value: unknown, relativeOnly = false): string | undefined {
  return admitLocal(value, relativeOnly);
}

function admitLocal(value: unknown, relativeOnly: boolean): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || CONTROL.test(value)) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('//')) return undefined;
  const drive = /^([a-z]):(?:\/|$)/iu.exec(normalized);
  if (SCHEME.test(normalized) && drive === null) return undefined;
  const absolute = drive !== null || normalized.startsWith('/');
  if (relativeOnly && absolute) return undefined;
  const body = drive === null ? normalized : normalized.slice(2);
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  if (drive !== null) return parts.length === 0 ? `${drive[1]!.toUpperCase()}:/` : `${drive[1]!.toUpperCase()}:/${parts.join('/')}`;
  if (normalized.startsWith('/')) return parts.length === 0 ? '/' : `/${parts.join('/')}`;
  if (relativeOnly && parts.length === 0) return undefined;
  return parts.length === 0 ? '.' : parts.join('/');
}

export function admittedLabelV2(raw: string, baseDirectory: string): string {
  const normalized = normalizeAdmittedPathV2(raw) ?? 'input';
  if (!isAbsoluteAdmittedPathV2(normalized)) return normalized;
  const base = normalizeAdmittedPathV2(baseDirectory) ?? '.';
  if (isAbsoluteAdmittedPathV2(base)) {
    const relative = relativeAdmitted(base, normalized);
    if (relative !== undefined && relative !== '..'
      && !relative.startsWith('../') && !relative.startsWith('/')
      && !isAbsoluteAdmittedPathV2(relative)) return relative;
  }
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'input';
}

export function toFsPathV2(baseDirectory: string, normalized: string): string {
  if (isAbsoluteAdmittedPathV2(normalized)) return normalized;
  const base = baseDirectory.replaceAll('\\', '/');
  if (base === '/' || /^[a-z]:\/$/iu.test(base)) return `${base}${normalized}`;
  const trimmed = base.replace(/\/+$/u, '');
  return trimmed === '' || trimmed === '.' ? normalized : `${trimmed}/${normalized}`;
}

export function isWithinBaseV2(target: string, baseDirectory: string): boolean {
  const targetPath = normalizeAdmittedPathV2(target);
  const base = normalizeAdmittedPathV2(baseDirectory);
  if (targetPath === undefined || base === undefined
    || !isAbsoluteAdmittedPathV2(targetPath) || !isAbsoluteAdmittedPathV2(base)) return false;
  const relative = relativeAdmitted(base, targetPath);
  return relative !== undefined && relative !== '..'
    && !relative.startsWith('../') && !relative.startsWith('/')
    && !isAbsoluteAdmittedPathV2(relative);
}

function relativeAdmitted(base: string, target: string): string | undefined {
  try {
    if (/^[a-z]:\//iu.test(base) || /^[a-z]:\//iu.test(target)) {
      return win32.relative(base.replaceAll('/', '\\'), target.replaceAll('/', '\\')).replaceAll('\\', '/');
    }
    return posix.relative(base, target);
  } catch { return undefined; }
}
