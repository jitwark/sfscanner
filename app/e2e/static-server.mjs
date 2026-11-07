/**
 * Serves the real static export for local end-to-end tests.
 *
 * The scanner's responsiveness budget is meaningless against `next dev`: an
 * unminified React build with HMR attached adds tens of milliseconds of
 * main-thread work that will never exist in production. These tests measure the
 * artifact we actually deploy, from `out/`, under its configured project path.
 * This local server does not claim or synthesize GitHub Pages cache headers.
 *
 *   node e2e/static-server.mjs [port]
 *
 * `createStaticServer` is exported so `e2e/static-server.test.ts` can bind the
 * real handler to an ephemeral port over a temporary root and assert the range
 * mechanics directly. Importing this module must not bind anything: the CLI
 * start is guarded by the direct-run check at the bottom of the file.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 3210;

const defaultRoot = resolve(import.meta.dirname, '..', 'out');
const configuredBasePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '')
  .replace(/^\/+|\/+$/g, '');
const defaultBasePath = configuredBasePath ? `/${configuredBasePath}` : '';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolve one `Range` request header against a representation of `size` bytes.
 *
 * Returns an inclusive `{ start, end }` for the single range the product's
 * `fetchChart` asks for, `'unsatisfiable'` when the specifier is valid but no
 * byte of the file can satisfy it (a `416`, never an empty `206`), or `null`
 * when the header must be ignored and the whole file served as `200`.
 *
 * Ignored, not rejected — the previous regex matched only `bytes=N-M` and
 * `bytes=N-`, so every other form fell through to a `200` carrying the whole
 * representation. For a 16 MB shard that is the exact transfer these tests
 * exist to prevent, and it hides behind a `200` that the caller cannot tell
 * apart from a host that never supported ranges:
 *   - an unknown range unit or a malformed specifier (`bytes=abc`, `items=0-1`);
 *   - a byte-range-spec whose last-byte-pos precedes its first (`bytes=10-5`),
 *     invalid per RFC 9110 §14.1.2 and ignored per §14.2;
 *   - a multi-range request (`bytes=0-9,20-29`). This harness answers the
 *     single-range form the product sends; §14.2 permits ignoring a Range
 *     header rather than emitting a `multipart/byteranges` body.
 *
 * Unsatisfiable, because the set is well formed and simply beyond the file:
 *   - a first-byte-pos at or past the last byte (`bytes=${size}-`);
 *   - an empty suffix (`bytes=-0`), or any range at all on an empty file.
 */
export function resolveRange(header, size) {
  const specifier = typeof header === 'string' ? header.trim() : '';
  if (!specifier.startsWith('bytes=')) return null;

  const ranges = specifier.slice('bytes='.length).split(',');
  if (ranges.length !== 1) return null;

  const match = /^(\d*)-(\d*)$/.exec(ranges[0].trim());
  if (!match) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;

  // `bytes=-N`: the last N bytes, or all of them when the file is shorter.
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  if (last === '') return { start, end: size - 1 };

  const requestedEnd = Number(last);
  if (requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * Stream a file — or the requested slice of it — to the response.
 *
 * The descriptor's lifetime belongs to the client, not to the file: piping a
 * slice of a 16 MB shard into a response whose client has gone leaves the read
 * running into a dead socket, because `pipe` does not destroy its source when
 * the destination closes. The product does exactly that — it cancels the body
 * of a `200` and aborts the fetch when the reader leaves the page. An fs error
 * mid-stream (the file changed under a served export) would otherwise surface
 * as an uncaught `'error'` event and take the whole server down.
 */
function streamFile(response, file, options) {
  const source = createReadStream(file, options);
  source.on('error', () => response.destroy());
  response.on('close', () => {
    if (!response.writableEnded) source.destroy();
  });
  source.pipe(response);
}

export function createStaticServer({ root = defaultRoot, basePath = defaultBasePath } = {}) {
  async function resolveFile(urlPath) {
    let requested;
    try {
      requested = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname);
    } catch {
      return null;
    }
    if (basePath && requested !== basePath && !requested.startsWith(`${basePath}/`)) return null;
    const withinSite = basePath ? requested.slice(basePath.length) || '/' : requested;
    if (withinSite.split(/[\\/]/).includes('..')) return null;
    const relativePath = normalize(withinSite).replace(/^[/\\]+/, '');
    const candidate = resolve(root, relativePath);
    const fromRoot = relative(root, candidate);
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return null;

    const direct = await stat(candidate).catch(() => null);
    if (direct?.isFile()) return candidate;
    if (direct?.isDirectory()) {
      const index = join(candidate, 'index.html');
      return (await stat(index).catch(() => null))?.isFile() ? index : null;
    }

    // Next's exported RSC flight files flatten dynamic route directories into
    // a dotted URL (for example `__next.w.$d$slug.__PAGE__.txt`) while the
    // export stores them as `__next.w/$d$slug/__PAGE__.txt`. GitHub Pages serves
    // the HTML without this request, but the browser prefetch path exercises it
    // during navigation, so resolve the two representations consistently here.
    // This previously matched only the dynamic-route shape, which has exactly one
    // parameter segment. Static routes flatten to one segment fewer
    // (`/library/__next.library.__PAGE__.txt` over `__next.library/__PAGE__.txt`)
    // and fell through to a 404, so every prefetch from a `next/link` in the
    // header logged a console error — four per page, which failed the scanner's
    // "error-free scan" assertion. Split on the dots instead of counting them.
    const flight = relativePath.replaceAll('\\', '/').match(/^(.*\/)?(__next\.[^/]*)\.__PAGE__\.txt$/);
    if (flight) {
      const [, prefix = '', dotted] = flight;
      // `__next.a.b` -> `__next.a/b`; the `__next.` prefix keeps its own dot.
      const [namespace, route, ...rest] = dotted.split('.');
      const flightPath = join(root, prefix, `${namespace}.${route}`, ...rest, '__PAGE__.txt');
      if ((await stat(flightPath).catch(() => null))?.isFile()) return flightPath;
    }

    const html = `${candidate.replace(/[/\\]$/, '')}.html`;
    return (await stat(html).catch(() => null))?.isFile() ? html : null;
  }

  return createServer(async (request, response) => {
    const file = await resolveFile(request.url ?? '/');
    if (!file) {
      const notFound = await resolveFile(`${basePath}/404.html`);
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      if (notFound) return streamFile(response, notFound);
      return response.end('Not found');
    }

    // Range support, because the product depends on it. A workflow's chart is one
    // line inside a 16 MB shard and `fetchChart` asks for exactly that line's
    // bytes; without a 206 here the tests exercised a fallback path that GitHub
    // Pages never takes, and the real one went unexercised. `resolveRange` owns
    // the semantics; this block only has to answer them without lying about how
    // many bytes are coming.
    const contentType = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    const header = request.headers.range;
    if (header !== undefined) {
      const size = (await stat(file)).size;
      const range = resolveRange(header, size);
      if (range === 'unsatisfiable') {
        // A `416` describes the representation it could not satisfy and carries
        // no body; answering an unsatisfiable range with an empty `206` would
        // promise a `Content-Range` window that never arrives.
        response.writeHead(416, {
          'accept-ranges': 'bytes',
          'content-length': '0',
          'content-range': `bytes */${size}`,
        });
        return response.end();
      }
      if (range) {
        const { start, end } = range;
        response.writeHead(206, {
          'content-type': contentType,
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
        });
        return streamFile(response, file, { start, end });
      }
    }

    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-type': contentType,
    });
    streamFile(response, file);
  });
}

// Bind a listener only when this file is the program, so the regression test in
// `e2e/static-server.test.ts` can import the factory without competing for the
// port every caller (`playwright.config.ts`, `visual-baselines.mjs`,
// `measure-baseline.mjs`, `probe-lib.mjs`) spawns this script on.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? DEFAULT_PORT);
  createStaticServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`static export served on http://127.0.0.1:${port}\n`);
  });
}
