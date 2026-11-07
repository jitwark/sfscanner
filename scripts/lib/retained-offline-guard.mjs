import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Instrument the concrete Node network routes used by CLI/worker/MCP code.
 * This is an observable offline regression guard, not an OS hostile-code sandbox.
 */
export function createRetainedOfflineGuard(consumer, run) {
  const guardPath = path.join(consumer, 'offline-guard.mjs');
  writeFileSync(guardPath, [
    "import http from 'node:http'; import https from 'node:https'; import http2 from 'node:http2';",
    "import net from 'node:net'; import dns from 'node:dns'; import tls from 'node:tls'; import dgram from 'node:dgram';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const fail = () => { throw new Error('RETAINED_OFFLINE_VIOLATION'); };",
    'globalThis.__RETAINED_NETWORK_GUARD__ = fail; globalThis.fetch = fail;',
    'http.request = fail; http.get = fail; https.request = fail; https.get = fail; http2.connect = fail;',
    'http.Agent.prototype.createConnection = fail; https.Agent.prototype.createConnection = fail;',
    'net.connect = fail; net.createConnection = fail; net.Socket.prototype.connect = fail; net.Server.prototype.listen = fail;',
    'tls.connect = fail; dgram.createSocket = fail;',
    "for (const key of ['send', 'connect', 'bind']) dgram.Socket.prototype[key] = fail;",
    'for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {',
    "  for (const key of Object.getOwnPropertyNames(object)) if (key.startsWith('resolve') || ['lookup', 'lookupService', 'reverse'].includes(key)) object[key] = fail;",
    '}',
    "if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = class { constructor() { fail(); } };",
    'syncBuiltinESMExports();',
  ].join('\n'));
  const guardUrl = pathToFileURL(guardPath).href;
  const guardedRun = (command, args, options = {}) => {
    const result = run(command, args, {
      ...options, env: { ...process.env, ...options.env, NODE_OPTIONS: '--import=' + guardUrl },
    });
    if (result.stderr.includes('RETAINED_OFFLINE_VIOLATION')) throw new Error('Retained offline process attempted network access');
    return result;
  };
  return guardedRun;
}

export function checkRetainedOfflineGuard(consumer, run) {
  const control = path.join(consumer, 'offline-control.mjs');
  writeFileSync(path.join(consumer, 'offline-worker-control.mjs'), [
    "import { parentPort } from 'node:worker_threads'; import { connect } from 'node:net';",
    "parentPort.postMessage(typeof globalThis.__RETAINED_NETWORK_GUARD__ === 'function' && connect === globalThis.__RETAINED_NETWORK_GUARD__);",
  ].join('\n'));
  writeFileSync(control, [
    "import { request } from 'node:http'; import { connect, createConnection, Socket } from 'node:net';",
    "import { lookup } from 'node:dns'; import dns from 'node:dns/promises'; import { connect as tlsConnect } from 'node:tls';",
    "import { connect as http2Connect } from 'node:http2'; import { createSocket } from 'node:dgram';",
    "import { Worker } from 'node:worker_threads';",
    'const expected = globalThis.__RETAINED_NETWORK_GUARD__;',
    'const routes = [fetch, request, connect, createConnection, Socket.prototype.connect, lookup, dns.lookup, dns.resolve, tlsConnect, http2Connect, createSocket];',
    '// Compare first: a broken guard must never let the positive control initiate real traffic.',
    "for (const route of routes) { if (typeof expected !== 'function' || route !== expected) throw new Error('OFFLINE_GUARD_ROUTE_UNPATCHED');",
    "  let blocked = false; try { route(); } catch (error) { blocked = String(error).includes('RETAINED_OFFLINE_VIOLATION'); }",
    "  if (!blocked) throw new Error('OFFLINE_GUARD_CONTROL_FAILED'); }",
    "const worker = new Worker(new URL('./offline-worker-control.mjs', import.meta.url));",
    "try { const guarded = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); if (!guarded) throw new Error('OFFLINE_WORKER_UNPATCHED'); } finally { await worker.terminate(); }",
  ].join('\n'));
  const result = run(process.execPath, [control], { cwd: consumer });
  return { id: 'offline-guard-positive-routes', status: result.status === 0 ? 'pass' : 'fail' };
}
