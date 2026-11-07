import { parentPort, workerData } from 'node:worker_threads';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import type { ScanWorkerData } from './scan-worker-host';

parentPort?.postMessage(scanWorkflowV2(workerData as ScanWorkerData));
