import type { ReactNode } from 'react';
import { CornerSquare } from './primitives/corner-square';

/**
 * Precision CAD / blueprint workflow flare diagram for the hero chapter.
 * Adheres strictly to the engineering design specification: hyper-angular 2px geometry, zero drop shadow,
 * technical hairline traces, and the signature green corner square.
 */
export function HeroWorkflowFlare(): ReactNode {
  return (
    <aside
      aria-hidden="true"
      role="presentation"
      data-hero-workflow-flare
      className="relative hidden lg:flex flex-col items-center justify-center p-2 select-none"
    >
      <div
        className="relative w-[440px] xl:w-[480px] rounded-panel border border-hairline bg-panel p-5 overflow-hidden"
        style={{
          backgroundImage: 'radial-gradient(var(--theme-hairline-strong) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
        }}
      >
        <CornerSquare position="top-left" size="md" />

        {/* CAD Header Bar */}
        <div className="mb-4 flex items-center justify-between border-b border-hairline pb-3 pl-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 bg-accent" />
            <span className="font-mono text-xs font-bold text-ink">
              Active Automation Pipeline
            </span>
          </div>
          <span className="rounded-control border border-accent-border bg-accent/10 px-2 py-0.5 font-mono text-2xs font-bold text-accent-text">
            Verified · Score 99
          </span>
        </div>

        {/* Blueprint Vector Graph */}
        <div className="relative h-[200px] w-full">
          <svg
            viewBox="0 0 420 190"
            className="h-full w-full overflow-visible"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Connecting Circuit Wires */}
            <path
              d="M 95 45 C 145 45, 155 125, 205 125"
              stroke="var(--theme-hairline-strong)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
            <path
              d="M 95 45 C 145 45, 155 45, 205 45"
              stroke="var(--theme-accent)"
              strokeWidth="1.5"
            />
            <path
              d="M 295 45 C 335 45, 335 105, 365 105"
              stroke="var(--theme-accent)"
              strokeWidth="1.5"
            />
            <path
              d="M 295 125 C 335 125, 335 105, 365 105"
              stroke="var(--theme-hairline-strong)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />

            {/* Node 1: Webhook Trigger */}
            <g transform="translate(10, 20)">
              <rect width="85" height="48" rx="2" fill="var(--theme-page)" stroke="var(--theme-accent)" strokeWidth="1.5" />
              <rect x="0" y="0" width="4" height="48" rx="0" fill="var(--theme-accent)" />
              <text x="12" y="20" fontSize="10" fontWeight="700" fill="var(--theme-ink)">Webhook</text>
              <text x="12" y="34" fontSize="8" fontFamily="monospace" fill="var(--theme-muted)">Trigger</text>
            </g>

            {/* Node 2: AI Agent */}
            <g transform="translate(205, 20)">
              <rect width="90" height="48" rx="2" fill="var(--theme-page)" stroke="var(--theme-hairline-strong)" strokeWidth="1.5" />
              <rect x="0" y="0" width="4" height="48" rx="0" fill="var(--theme-accent)" />
              <text x="12" y="20" fontSize="10" fontWeight="700" fill="var(--theme-ink)">AI Agent</text>
              <text x="12" y="34" fontSize="8" fontFamily="monospace" fill="var(--theme-muted)">GPT-4o / Claude</text>
            </g>

            {/* Node 3: Data Transform */}
            <g transform="translate(205, 100)">
              <rect width="90" height="48" rx="2" fill="var(--theme-page)" stroke="var(--theme-hairline-strong)" strokeWidth="1.5" />
              <rect x="0" y="0" width="4" height="48" rx="0" fill="var(--theme-hairline-strong)" />
              <text x="12" y="20" fontSize="10" fontWeight="700" fill="var(--theme-ink)">Transform</text>
              <text x="12" y="34" fontSize="8" fontFamily="monospace" fill="var(--theme-muted)">Filter & Map</text>
            </g>

            {/* Node 4: Output / Dispatch */}
            <g transform="translate(325, 80)">
              <rect width="85" height="48" rx="2" fill="var(--theme-page)" stroke="var(--theme-hairline-strong)" strokeWidth="1.5" />
              <rect x="0" y="0" width="4" height="48" rx="0" fill="var(--theme-hairline-strong)" />
              <text x="12" y="20" fontSize="10" fontWeight="700" fill="var(--theme-ink)">Dispatch</text>
              <text x="12" y="34" fontSize="8" fontFamily="monospace" fill="var(--theme-muted)">Slack / GitHub</text>
            </g>
          </svg>
        </div>

        {/* Telemetry Footer */}
        <div className="mt-2 flex items-center justify-between border-t border-hairline pt-2.5 font-mono text-2xs text-ink-muted">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 bg-accent" />
            <span>4 Nodes · 4 Links</span>
          </div>
          <span className="font-bold text-accent-text">Deterministic Audit OK</span>
        </div>
      </div>
    </aside>
  );
}
