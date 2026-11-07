import { parentPort } from 'node:worker_threads';

const end = Date.now() + 30_000;
while (Date.now() < end) { /* deliberately blocking CPU work */ }
parentPort.postMessage({ ok: true });
