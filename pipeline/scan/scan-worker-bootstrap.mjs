import { createRequire } from 'node:module';
import { register } from 'tsx/cjs/api';

// Worker threads do not reliably inherit the tsx CLI loader on Windows. A
// JavaScript bootstrap can register the CommonJS hook before loading the
// TypeScript worker and its extensionless application imports.
register();
createRequire(import.meta.url)('./scan-worker.ts');
