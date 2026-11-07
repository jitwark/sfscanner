import { parentPort } from 'node:worker_threads';
import { scanJson, type CliScanOutcome, type ScanCoreOptions } from './scan-core.js';

export type CliScanWorkerRequest = {
  kind: 'scan';
  json: string;
  options: ScanCoreOptions;
};

export type CliScanWorkerResponse =
  | { kind: 'result'; outcome: CliScanOutcome }
  | { kind: 'error'; message: string };

export function handleCliScanRequest(request: CliScanWorkerRequest): CliScanWorkerResponse {
  try {
    return { kind: 'result', outcome: scanJson(request.json, request.options) };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Scanner worker failed.' };
  }
}

if (parentPort) {
  parentPort.once('message', (request: CliScanWorkerRequest) => {
    parentPort?.postMessage(handleCliScanRequest(request));
    parentPort?.close();
  });
}
