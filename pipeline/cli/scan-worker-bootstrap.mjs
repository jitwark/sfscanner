import { createRequire } from 'node:module';
import { register } from 'tsx/cjs/api';

// The CLI is launched through tsx, but Node worker threads do not reliably
// inherit its TypeScript loader on every supported platform. Registering the
// CommonJS hook here keeps the worker entry point runnable under Node 22.
register();
createRequire(import.meta.url)('./scan-worker.ts');
