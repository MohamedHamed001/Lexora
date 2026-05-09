# Changelog

All notable changes to this project are recorded here. Extension releases use the version in `extension/manifest.json` and `extension/manifest.firefox.json`.

## [1.10.0] — 2026-05-09

### Phase 3 — Content script modularization & highlighter tests

- **Content**: Split the former monolithic `content.js` into load-ordered modules under `extension/content/`: `highlighter-alignment.js` (pure alignment), `content-highlighter.js`, `content-overlay.js`, `content-selection-bar.js`, `content-router.js`, plus a thin `content.js` bootstrap.
- **Background**: `LEXORA_PAGE_SCRIPT_FILES` centralizes the inject list (used when the toolbar action injects into a tab).
- **Tests**: `extension/tests/highlighter-alignment.test.js` covers deterministic chunk-to-page alignment helpers.
- **E2E**: Fixture HTML extended past `LIMITS.HTML_READY_CHARS` so deep capture matches real extractor behavior; clearer assertion message on failure.

## [1.9.0] — 2026-05-09

### Phase 2 — Capture consistency, chat context, export UX

- **Capture**: `probePageContent` now shares the same `seen` deduplication set for HTML blocks and PDF text as `extractPageContent`, so probe readiness and full capture stay aligned.
- **Capture**: Published `LexoraCaptureExtractor.LIMITS` (`MIN_LESSON_CONTENT_CHARS`, `PROBE_BLOCK_CAP`, HTML/PDF readiness thresholds) to document scoring in one place.
- **Chat**: Long lessons are budgeted with **head + tail** truncation and an explicit middle omission marker (via `sidepanel/js/chat-context.js`) instead of only truncating the beginning.
- **Export**: If the jsPDF library is not available, the user sees a clear error in the export hint area instead of a no-op.

### Phase 1 — Structural hardening (same release)

- **Background**: `proxy.js` — streamed proxy responses capped (~4 MiB), IPv6 loopback in allowlist, shared validation.
- **Background**: `lesson-capture.js` — monotonic capture operation IDs for deep capture timeouts and auto-capture navigation races.
- **Highlights**: `lexoraHighlightTarget` `{ tabId, frameId }` with lesson storage; targeted highlight relay with multi-frame fallback.
- **Playback**: `playbackGen` on highlight/clear messages; content script ignores stale generations.
- **Audio**: Piper worker cancel/epoch; LRU-style trimming of Kokoro/Piper blob caches.
- **Content**: Overlay global `mousemove` / `mouseup` listeners removed on destroy.
- **Tooling**: ESLint `@eslint/js` recommended; `extension/tests/proxy.test.js`; Node globals for `scripts/**/*.mjs`.

## [1.8.0] — prior baseline

- Pre–Phase 1 / pre–Phase 2 feature set (see git history for detail).
