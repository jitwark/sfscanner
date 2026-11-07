/**
 * The document's Content-Security-Policy.
 *
 * GitHub Pages serves static files and cannot set response headers, so the
 * policy has to travel in the document. `'unsafe-inline'` for scripts is
 * unavoidable — the theme bootstrap and JSON-LD are inline and a static export
 * has no per-request nonce — but the directives that matter here still bind.
 *
 * `connect-src 'self'` is defence in depth for the document, NOT the scanner's
 * privacy boundary. Two limits, both reproduced in Chromium under this exact
 * policy (`docs/audit/2026-09-01/evidence/`):
 *
 *   - A worker runs under the CSP delivered with its own script response, not
 *     this document's <meta> policy. Pages sets no response headers, so this
 *     directive does not govern the external module worker that reads the
 *     workflow at all.
 *   - `connect-src` covers fetch/XHR/WebSocket/EventSource/ping/sendBeacon. It
 *     does not cover top-level navigation, and navigation directives do not
 *     inherit `default-src` — so with `'unsafe-inline'` scripts permitted,
 *     same-origin script could still exfiltrate via `window.location`.
 *
 * What actually enforces "nothing leaves your browser" is the source and
 * emitted-bundle audits (`check:browser-safe`, `check:browser-safe:emitted`)
 * plus the E2E request sentinel. See docs/SECURITY.md.
 *
 * It lives here, not inline in `layout.tsx`, so it has one assertable value.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  // `frame-ancestors` is deliberately absent. The CSP spec ignores it — along
  // with `report-uri` and `sandbox` — when the policy arrives in a <meta>
  // element, and Chrome logs a console error for each one on every page load.
  // Seven of those errors failed the scanner's "error-free scan" assertion.
  // This is a static export with no server, so there is no response header to
  // put it in; framing protection has to come from the host's headers.
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
