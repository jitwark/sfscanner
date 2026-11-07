// @vitest-environment node
import { Agent, request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer } from './static-server.mjs';

/**
 * The range mechanics `e2e/static-server.mjs` owes the suite, asserted against
 * the real handler over real HTTP rather than against a helper's return value.
 *
 * Why this file exists: a chart is one JSONL line inside a 16 MB shard, and the
 * product refuses to draw it from anything but a `206`. When this server gets a
 * range wrong, nothing here used to fail — the symptom surfaced as
 * `e2e/search-payload.spec.ts` timing out thirty seconds later, or as a browser
 * pulling sixteen megabytes it had to cancel. Binding the exported factory to an
 * ephemeral port over a temporary root keeps that regression here, in a test
 * that runs with the unit suite instead of needing a built export.
 */
const SIZE = 256;
const pattern = Buffer.from(Array.from({ length: SIZE }, (_, index) => index));

/** `socketPort` is the local port of the connection that carried the response. */
type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer; socketPort: number | undefined };

let root: string;
let port: number;
let server: Server;
let oneShot: Agent;
let reused: Agent;

function send(path: string, headers: OutgoingHttpHeaders, agent: Agent): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  // `response.socket` is already detached by `end`, so the port is read from the
  // socket the request was assigned — a reused keep-alive socket included.
  let socketPort: number | undefined;
  const outgoing = request({ host: '127.0.0.1', port, path, headers, agent }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks),
      socketPort,
    }));
  });
  outgoing.on('socket', (socket) => { socketPort = socket.localPort; });
  outgoing.on('error', reject);
  outgoing.end();
  return promise;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'static-server-'));
  await writeFile(join(root, 'shard.jsonl'), pattern);
  server = createStaticServer({ root, basePath: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  oneShot = new Agent({ keepAlive: false });
  reused = new Agent({ keepAlive: true, maxSockets: 1 });
});

afterAll(async () => {
  oneShot.destroy();
  reused.destroy();
  server.close();
  await once(server, 'close');
  await rm(root, { recursive: true, force: true });
});

describe('static-server range requests', () => {
  it('answers a bounded range with the inclusive window it promised', async () => {
    const response = await send('/shard.jsonl', { Range: 'bytes=10-19' }, oneShot);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 10-19/${SIZE}`);
    expect(response.headers['content-length']).toBe('10');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.body).toEqual(pattern.subarray(10, 20));
  });

  it('resolves an open-ended range to the last byte of the file', async () => {
    const response = await send('/shard.jsonl', { Range: 'bytes=250-' }, oneShot);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 250-255/${SIZE}`);
    expect(response.body).toEqual(pattern.subarray(250, SIZE));
  });

  it('resolves a suffix range to the last N bytes instead of the whole shard', async () => {
    const response = await send('/shard.jsonl', { Range: 'bytes=-16' }, oneShot);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 240-255/${SIZE}`);
    expect(response.body).toEqual(pattern.subarray(240, SIZE));
  });

  it('clamps an end past the file to the last byte it can actually send', async () => {
    const response = await send('/shard.jsonl', { Range: 'bytes=200-9999' }, oneShot);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 200-255/${SIZE}`);
    expect(response.headers['content-length']).toBe('56');
    expect(response.body).toEqual(pattern.subarray(200, SIZE));
  });

  it('answers a range no byte can satisfy with 416 and the full size, not an empty 206', async () => {
    for (const range of [`bytes=${SIZE}-`, 'bytes=-0']) {
      const response = await send('/shard.jsonl', { Range: range }, oneShot);

      expect(response.status, `${range} must be unsatisfiable`).toBe(416);
      expect(response.headers['content-range']).toBe(`bytes */${SIZE}`);
      expect(response.headers['content-length']).toBe('0');
      expect(response.body).toHaveLength(0);
    }
  });

  it('ignores a header it will not honour rather than promising half a body', async () => {
    // A multi-range request and an unknown range unit are both answered with the
    // whole representation, which is what a static host does with a `Range` it
    // does not serve — the caller sees a `200`, never a `206` window that does
    // not line up with the bytes behind it.
    for (const range of ['bytes=0-9,20-29', 'items=0-9']) {
      const response = await send('/shard.jsonl', { Range: range }, oneShot);

      expect(response.status, `${range} must not be a partial response`).toBe(200);
      expect(response.headers['content-range']).toBeUndefined();
      expect(response.body).toEqual(pattern);
    }
  });

  it('ends each slice, so the next range can reuse the connection', async () => {
    const first = await send('/shard.jsonl', { Range: 'bytes=0-9' }, reused);
    const second = await send('/shard.jsonl', { Range: 'bytes=246-255' }, reused);

    expect(first.status).toBe(206);
    expect(first.body).toEqual(pattern.subarray(0, 10));
    expect(second.status).toBe(206);
    expect(second.body).toEqual(pattern.subarray(246, SIZE));
    // Both responses came back over one connection, which only happens if the
    // first slice ended where its `Content-Length` said it would. A slice left
    // dangling behind that count never frees the socket, so with `maxSockets: 1`
    // the second request would hang here instead of reaching the server.
    expect(first.socketPort).toBeDefined();
    expect(second.socketPort).toBe(first.socketPort);
  });
});
