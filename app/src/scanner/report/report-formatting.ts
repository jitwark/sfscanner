import type { ScanWorkflowResult } from '../engine';

export function anatomy(scan: ScanWorkflowResult): Array<[string, string]> {
  const w = scan.workflow;
  return [
    ['Nodes', `${w.nodeCount} ${pluralize('node', w.nodeCount)}`],
    ['Triggers', `${w.triggerCount}`],
    ['Actions', `${w.actionCount}`],
    ['Integrations', `${w.integrationCount}`],
    ['Connections', `${w.connectionCount}`],
    ['Payload', formatBytes(w.payloadBytes)],
    ['Complexity', w.complexity],
  ];
}

export function pluralize(noun: string, value: number): string {
  return value === 1 ? noun : `${noun}s`;
}

export function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function location(value?: { nodeName?: string; path?: string }): string {
  if (!value) return '';
  return value.nodeName ? ` / Node: ${value.nodeName}` : value.path ? ` / Path: ${value.path}` : '';
}
