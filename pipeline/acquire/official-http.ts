const USER_AGENT = 'n8n-community-hub/0.1 (official-template-catalogue)';

export type HttpOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxRetries?: number;
};

/**
 * Shared across every request in a run. `concurrency` is mutable on purpose:
 * the pool re-reads it between dispatches, so a 429 anywhere shrinks the whole
 * run rather than failing it.
 */
export type HttpState = { concurrency: number };

export function createHttpState(concurrency: number): HttpState {
  return { concurrency: Math.max(1, Math.floor(concurrency)) };
}

/**
 * Carries the HTTP status so a caller can tell "this template no longer exists
 * upstream" (404, expected, drop the entry) from "we could not reach the API"
 * (retryable, and a run full of them is a broken run, not a small corpus).
 */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`official API request failed (${status})`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

const defaultSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export async function requestJson(url: string, options: HttpOptions, state: HttpState): Promise<unknown> {
  const fetcher = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retries = options.maxRetries ?? 5;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 429) {
        // Back off for everyone, not just this request.
        state.concurrency = Math.max(1, Math.floor(state.concurrency / 2));
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new HttpStatusError(response.status);
      }
    } catch (err) {
      if (attempt === retries || (err instanceof Error && err.message.startsWith('official API request failed'))) {
        throw err;
      }
    }

    await sleep(250 * 2 ** attempt + Math.floor(random() * 100));
  }

  throw new Error('official API request failed');
}

/**
 * Bounded-concurrency map. Results keep input order; `getLimit` is read before
 * every dispatch so the limit can move while the pool is running.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  getLimit: () => number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let next = 0;
  let active = 0;
  let failure: unknown;
  let settled = false;

  return new Promise<R[]>((resolve, reject) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (failure !== undefined) reject(failure);
      else resolve(results);
    };

    const pump = (): void => {
      if (settled) return;
      if (next >= items.length && active === 0) {
        finish();
        return;
      }
      while (active < Math.max(1, getLimit()) && next < items.length && failure === undefined) {
        const index = next;
        next += 1;
        active += 1;
        void fn(items[index] as T, index)
          .then(
            (value) => {
              results[index] = value;
            },
            (err: unknown) => {
              failure ??= err;
            },
          )
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (failure !== undefined && active === 0) finish();
    };

    pump();
  });
}
