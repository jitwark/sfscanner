'use client';

import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { AlertCircle, Globe, PencilLine, Shield, Upload } from 'lucide-react';
import { MAX_WORKFLOW_BYTES, MAX_WORKFLOW_BYTES_LABEL, exceedsWorkflowByteLimit, parseApprovedDomains } from './scanner-input-validation';
import { SAFE_SAMPLE_WORKFLOW } from './safe-sample-workflow';
export { MAX_WORKFLOW_BYTES, MAX_WORKFLOW_BYTES_LABEL } from './scanner-input-validation';
export type ScanProfile = 'beta-default';
export type ScanRequest = { json: string; profile: ScanProfile; approvedDomains: string[] };

/**
 * Sizes are measured in UTF-8 bytes, not string length.
 *
 * `json.length` counts UTF-16 code units, and the byte cap is enforced on
 * bytes — by `TextEncoder` in the worker and by `file.size` on upload. A
 * workflow with emoji node names or CJK sticky notes runs 3-4 bytes per
 * character, so a length-based summary would tell the reader a size below
 * `MAX_WORKFLOW_BYTES_LABEL` about a file the scanner then rejects for
 * exceeding it. Two numbers for one quantity, disagreeing on screen, is the
 * defect this project keeps finding.
 */
function describeInput(json: string): string {
  const bytes = new TextEncoder().encode(json).length;
  const kib = bytes / 1024;
  const size = kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(kib))} KiB`;
  const lines = json.split('\n').length;
  return `${size} · ${lines.toLocaleString('en-US')} lines`;
}

const controlClass =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control border border-hairline bg-raised px-3 font-mono text-xs font-medium transition-all hover:border-hairline-strong hover:bg-accent-dim active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40';

export function ScannerInput({ isScanning, hasResult = false, onScan, onDraftChange }: {
  isScanning: boolean;
  /** A report is on screen, so the editor collapses to a summary. See `showEditor`. */
  hasResult?: boolean;
  onScan: (request: ScanRequest) => void;
  onDraftChange?: () => void;
}) {
  const [jsonText, setJsonText] = useState('');
  const [domainsText, setDomainsText] = useState('');
  const [showDomains, setShowDomains] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * The editor is hidden once a report is on screen, and the reason is
   * measured rather than aesthetic.
   *
   * A textarea holding a large workflow is laid out in full whenever the page's
   * layout is invalidated — the browser has to measure every line to size the
   * scroll region. Rendering the report invalidates exactly that, so the
   * 507 KiB stress fixture cost a **50 ms** main-thread block for text nobody
   * is reading at that moment: median max frame gap 84 ms with the editor in
   * layout, 34 ms without. The scan itself is ~4 ms, in a Worker.
   *
   * `content-visibility`, `contain`, a pinned height, and `preventScroll` on
   * the focus call were all measured and none of them helped — the browser
   * still measures the text. Taking it out of layout is the only thing that
   * does.
   *
   * It is also the better page: after a scan the report is the point, and the
   * JSON you just pasted is noise above it. Nothing is lost — the text is still
   * in state, "Edit JSON" brings it straight back, and re-scanning does not
   * require it.
   */
  const showEditor = !isScanning && (!hasResult || isEditing);

  // Encoding a large workflow to count its bytes is not free, and this panel
  // re-renders on drag and on the domains toggle. Only the text decides it.
  const inputSummary = useMemo(() => (showEditor || isScanning ? '' : describeInput(jsonText)), [showEditor, isScanning, jsonText]);

  function submit(json: string) {
    if (isScanning || !json.trim()) return;
    if (exceedsWorkflowByteLimit(json)) {
      setInputError(`This workflow is larger than ${MAX_WORKFLOW_BYTES_LABEL}. Choose one n8n workflow export under the local scanner limit.`);
      return;
    }
    const parsed = parseApprovedDomains(domainsText);
    if (parsed.rejected.length > 0) {
      setInputError(`Check these domain values: ${parsed.rejected.join(', ')}. Use hostnames or http(s) URLs without credentials or wildcards.`);
      return;
    }
    setInputError(null); setIsEditing(false);
    onScan({
      json,
      profile: 'beta-default',
      approvedDomains: parsed.domains,
    });
  }

  function processFile(file: File) {
    if (isScanning) return;
    if (file.size > MAX_WORKFLOW_BYTES) {
      setInputError(`This file is larger than ${MAX_WORKFLOW_BYTES_LABEL}. Choose one n8n workflow export under the local scanner limit.`);
      return;
    }
    setInputError(null);
    const reader = new FileReader();
    reader.onerror = () => setInputError('The browser could not read this file. Export it from n8n again or paste its JSON below.');
    reader.onload = (event) => {
      const content = typeof event.target?.result === 'string' ? event.target.result : '';
      if (!content) {
        setInputError('This file did not contain readable workflow JSON.');
        return;
      }
      setJsonText(content);
      onDraftChange?.();
      submit(content);
    };
    reader.readAsText(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isScanning) return;
    const file = event.dataTransfer.files[0];
    if (file) return processFile(file);
    const pasted = event.dataTransfer.getData('text');
    if (pasted) {
      setJsonText(pasted);
      onDraftChange?.();
      submit(pasted);
    }
  }

  function loadSample() { onDraftChange?.(); setJsonText(SAFE_SAMPLE_WORKFLOW); setInputError(null); setIsEditing(true); }
  function clearInput() { onDraftChange?.(); setJsonText(''); setDomainsText(''); setInputError(null); setIsEditing(true); }

  return (
    <div className="rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Scan a workflow</h2>
          <p className="mt-1 text-sm text-ink-muted">Paste JSON or drop an n8n Download file.</p>
        </div>
        <div className="rounded-control border border-accent-border/50 bg-accent-dim px-3 py-2" aria-label="Selected scanner profile: Default scan">
          <p className="font-mono text-xs font-semibold text-accent-text">Default scan</p>
          <p className="mt-0.5 text-2xs text-ink-muted">Workflow structure and built-in security policy analysis</p>
        </div>
      </div>

      <div aria-disabled={isScanning}
        onDragOver={(event) => { event.preventDefault(); if (!isScanning) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}
        className={`mt-4 rounded-panel border-2 border-dashed p-4 transition-colors ${isDragging ? 'border-accent-border bg-accent-dim' : 'border-hairline bg-raised/30'} ${isScanning ? 'opacity-60' : ''}`}>
        {showEditor ? <>
          <label htmlFor="workflow-json" className="sr-only">Workflow JSON</label>
          <textarea id="workflow-json" value={jsonText} disabled={isScanning}
            onChange={(event) => { onDraftChange?.(); setJsonText(event.target.value); setInputError(null); }}
            placeholder="Paste workflow JSON here or drag and drop a .json file..." rows={6}
            className="w-full resize-y bg-transparent font-mono text-xs text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:cursor-not-allowed" />
        </> : isScanning ? <div role="status" aria-live="polite" className="rounded-control border border-accent-border/30 bg-accent-dim p-3 text-sm text-ink">
          <p className="font-semibold">Scanning workflow locally</p>
          <p className="mt-1 text-xs text-ink-muted">The JSON stays in memory while the Web Worker analyses it.</p>
        </div> : <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs text-ink-muted">
            <span className="text-ink">Scanned workflow</span> · {inputSummary}
          </p>
          <button type="button" onClick={() => setIsEditing(true)} className={`${controlClass} text-ink`}>
            <PencilLine className="h-4 w-4 text-accent-text" aria-hidden="true" /><span>Edit JSON</span>
          </button>
        </div>}

        <div className="mt-3 flex flex-col gap-3 border-t border-hairline pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".json,application/json" disabled={isScanning}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) processFile(file); event.target.value = ''; }} className="hidden" />
            <button type="button" disabled={isScanning} onClick={() => fileInputRef.current?.click()} className={`${controlClass} text-ink`}>
              <Upload className="h-4 w-4 text-accent-text" aria-hidden="true" /><span>Upload .json</span>
            </button>
            <button type="button" disabled={isScanning} onClick={loadSample} className={`${controlClass} text-ink-muted`}>
              <span>Load safe sample</span>
            </button>
            {jsonText ? <button type="button" disabled={isScanning} onClick={clearInput} className={`${controlClass} text-ink-muted`}>
              <span>Clear</span>
            </button> : null}
            <button type="button" disabled={isScanning} aria-expanded={showDomains} aria-controls="expected-domains"
              onClick={() => setShowDomains((open) => !open)} className={`${controlClass} text-ink-muted`}>
              <Globe className="h-4 w-4 text-accent-text" aria-hidden="true" /><span>{showDomains ? 'Hide domains' : 'Expected domains'}</span>
            </button>
          </div>
          <button type="button" onClick={() => submit(jsonText)} disabled={isScanning || !jsonText.trim()} aria-busy={isScanning}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-4 font-mono text-xs font-semibold text-accent-ink transition-all hover:brightness-95 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40">
            <Shield className="h-4 w-4" aria-hidden="true" /><span>{isScanning ? 'Scanning…' : 'Scan workflow'}</span>
          </button>
        </div>

        {showDomains ? <div id="expected-domains" className="mt-3 border-t border-hairline pt-3">
          <label htmlFor="domains-input" className="font-display text-xs font-semibold text-ink">Hosts you expect this workflow to contact</label>
          <p className="mt-1 text-xs text-ink-muted">Optional. Exact hostnames enable the unexpected-destination check; ports and paths are removed.</p>
          <input id="domains-input" type="text" value={domainsText} disabled={isScanning}
            onChange={(event) => { onDraftChange?.(); setDomainsText(event.target.value); setInputError(null); }}
            placeholder="api.stripe.com, hooks.slack.com" className="mt-2 min-h-11 w-full rounded-control border border-hairline bg-raised px-3 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-hairline-strong disabled:cursor-not-allowed disabled:opacity-40" />
        </div> : null}

        {inputError ? <div className="mt-3 flex items-start gap-2 border-t border-sev-critical pt-3 text-sm text-sev-critical" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{inputError}</span>
        </div> : null}
      </div>
    </div>
  );
}
