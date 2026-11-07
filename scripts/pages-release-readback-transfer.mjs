import { createHash } from 'node:crypto';
import { fail, PAGES_LIMITS } from './pages-release-paths.mjs';

const MiB = 1024 * 1024;
const RETRY_CUSHION_BYTES = 4 * MiB;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const MAX_READBACK_TRANSFER_BYTES = PAGES_LIMITS.bytes + 16 * MiB;

export function createReadbackTransfer({ manifestBytes, maxAttempts, maxTransferBytes }) {
  if (!Number.isSafeInteger(manifestBytes) || manifestBytes < 0) fail('invalid manifest byte total');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) fail('invalid attempt count');
  const retryAllowance = Math.min(MAX_READBACK_TRANSFER_BYTES, manifestBytes * maxAttempts + RETRY_CUSHION_BYTES);
  const limit = maxTransferBytes ?? retryAllowance;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READBACK_TRANSFER_BYTES) fail('invalid transfer budget');
  return { limit, used: 0, remaining: limit };
}

function charge(transfer, bytes) {
  transfer.used += bytes;
  transfer.remaining -= bytes;
  if (transfer.remaining < 0) fail('transfer budget exceeded');
}

function publicTarget(base, relative) {
  const encoded = relative.split('/').map((part) => encodeURIComponent(part)).join('/');
  return new URL(encoded, base);
}

function withinDeploymentBase(candidate, base) {
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return candidate.origin === base.origin
    && (candidate.pathname === basePath || candidate.pathname === basePath.slice(0, -1)
      || candidate.pathname.startsWith(basePath));
}

function transientNetworkError(error) {
  return error?.name === 'AbortError' || error instanceof TypeError
    || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code);
}

async function receive(response, transfer, digest = null) {
  if (!response.body) return digest?.digest('hex') ?? null;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    charge(transfer, chunk.length);
    digest?.update(chunk);
  }
  return digest?.digest('hex') ?? null;
}

async function fetchResponse(url, base, options, transfer, deadline) {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('anonymous readback timeout');
    const signal = AbortSignal.timeout(Math.min(options.perRequestTimeoutMs, remaining));
    const response = await options.fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: '*/*', 'cache-control': 'no-cache' },
    });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get('location');
    await receive(response, transfer);
    if (!location) fail('redirect without location');
    if (redirects >= options.maxRedirects) fail('redirect limit exceeded');
    current = new URL(location, current);
    if (!withinDeploymentBase(current, base)) fail('redirect outside deployment base path');
  }
}

async function acceptedBody(response, entry, transfer) {
  if (!response.body) {
    if (entry.size !== 0) fail(`public body missing for ${entry.path}`);
    return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  }
  const digest = createHash('sha256');
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    charge(transfer, chunk.length);
    if (size > entry.size) fail(`public size mismatch for ${entry.path}`);
    digest.update(chunk);
  }
  if (size !== entry.size) fail(`public size mismatch for ${entry.path}`);
  return digest.digest('hex');
}

export async function verifyPublicFile({ entry, base, options, transfer, deadline }) {
  let lastTransient = false;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const response = await fetchResponse(
        publicTarget(base, entry.path), base, options, transfer, deadline,
      );
      const acceptedStatus = response.status === 200 || entry.path === '404.html' && response.status === 404;
      if (acceptedStatus) {
        if (await acceptedBody(response, entry, transfer) !== entry.sha256) {
          fail(`public bytes mismatch for ${entry.path}`);
        }
        return;
      }
      await receive(response, transfer);
      if (!TRANSIENT_STATUS.has(response.status)) fail(`public HTTP ${response.status} for ${entry.path}`);
      lastTransient = true;
    } catch (error) {
      if (!transientNetworkError(error)) throw error;
      lastTransient = true;
    }
    if (attempt < options.maxAttempts) await options.retryDelay(attempt);
  }
  if (lastTransient) fail(`retry attempts exhausted for ${entry.path}`);
}
