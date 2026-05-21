<p align="center">
  <strong>✦ Lexora: Webpage TTS & AI Study Companion</strong>
</p>

<p align="center">
  A cross-browser extension that captures any webpage, reads it aloud with neural text-to-speech, highlights words in real time, and lets you chat with the content, all running locally and offline.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/chrome-%E2%9C%93-green" alt="Chrome" />
  <img src="https://img.shields.io/badge/firefox-%E2%9C%93-orange" alt="Firefox" />
  <img src="https://img.shields.io/badge/license-MIT-purple" alt="MIT License" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [What's New](#whats-new)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Installation & Setup](#installation--setup)
- [Usage](#usage)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

**Lexora** is a browser extension that transforms any webpage into an interactive study session. It captures page content (including text hidden inside iframes and collapsed accordions), synthesizes it into natural-sounding audio using local neural TTS engines, and highlights each spoken word on the original page in real time. A built-in AI chatbot lets you ask questions about the captured content, and a one-click PDF export saves everything offline.

The extension was born from a simple personal need: I lose focus when I only read. Listening while following along visually keeps me locked in. I built Lexora so I could study Udacity courses and long-form articles hands-free, and it works on virtually any text-heavy webpage: Medium articles, documentation sites, LMS platforms, blogs, and more.

### Core Idea

1. **Capture** a webpage's text content with one click.
2. **Listen** to it read aloud with neural-quality voices.
3. **Follow along** with real-time word-by-word highlighting on the page.
4. **Ask questions** about the material via an LLM-powered chat.
5. **Export** the content as a clean PDF.

---

## What's New

### v2.0.0 — LEXORA is now Supercharged with SuperTonic!

Lexora has taken a massive leap forward in version 2.0.0, introducing **SuperTonic**, a state-of-the-art, multi-stage, high-fidelity local text-to-speech engine alongside our existing pipelines! Additionally, the entire visual layout has been simplified and rebuilt around brand-new premium segmented controls, discarding all complex model jargon.

#### What's New in v2.0.0:
- **SuperTonic Neural TTS Engine Integration**: Fully offline, high-fidelity, highly expressive multi-stage local narration running on-device via ONNX Runtime Web.
- **Premium "Text-to-Speech mode" Interface**: Replaced the technical, complex model dropdown picker with a beautiful, modern horizontal segmented control supporting **Fast** ⚡️ (Piper), **Balanced** ⚖️ (Kokoro), and **Quality** 🏆 (SuperTonic) options, keeping the UI intuitive and non-technical.
- **Local WASM/JSEP CSP Resolution**: Scoped both Kokoro and SuperTonic web workers to strictly load WebAssembly and JSEP modules from the local extension bundle directory instead of CDNs. This fully complies with strict Chrome Extension Manifest V3 Content Security Policies (CSP) and enables complete offline-first operation.
- **Simplified Kokoro Engine Configuration**: Defaulted the Kokoro engine exclusively to the high-efficiency Q8 model variant (~92 MB download) and removed the technical `q4` vs `q8` choice to streamline user configuration.
- **SuperTonic "Howling Sound" Resolution**: Fully replaced the naive char-level tokenizer with the official `unicode_indexer` code-point lookup dictionary, fixed latent dimension alignments, incorporated `attention_mask` tensors, and implemented a proper 8-step flow-matching Euler denoising loop.
- **Robust Fail-Safe Mechanisms**: Implemented an automated fallback to the native browser `speechSynthesis` API when WebGL/WebGPU or ONNX context is unavailable.

### v1.10.0 — Phase 3: Content modularization + reliability fixes

- **Content scripts split**: The former monolithic `content.js` is now a thin bootstrap that loads ordered modules from `extension/content/` — `highlighter-alignment.js` (pure alignment), `content-highlighter.js`, `content-overlay.js`, `content-selection-bar.js`, `content-router.js`.
- **Shared constants**: New `extension/lexora-constants.js` exposes `MIN_CAPTURE_CONTENT_CHARS`. Consumed by `message-guards.js`, `capture-extractor.js`, and `background.js` so the “best frame” threshold can never drift again.
- **Background injection list**: `LEXORA_PAGE_SCRIPT_FILES` centralizes the page-inject sequence used by the toolbar action, and `lexora-constants.js` is prepended everywhere `capture-extractor.js` is injected.
- **Highlight relay**: Uses `lexoraHighlightTarget { tabId, frameId }` to message the exact tab/frame, falling back to the active tab + all frames only when the target is gone.
- **Probe**: `ui.js` now uses a single async `sendRuntimeMessageSafe` path instead of the previous callback + promise double-handling.
- **Ask AI from selection**: One delivery path via `storage.local.lexoraPendingAskAi`. The side panel drains it on init and via `storage.onChanged`, so requests survive the panel being closed.
- **Chat payload budget**: Trims history (and the last user message if needed) so JSON stays comfortably under the 250 KB proxy cap.
- **Selection bar**: Guards `selection.rangeCount > 0` before `getRangeAt(0)`.
- **Kokoro worker**: 120 s `Promise.race` timeout around `from_pretrained` with a clear UI error.
- **Progress migration**: In-memory single-flight per progress key prevents duplicate legacy-key migration storms.
- **Settings UI**: Cleaned up theme block indentation/braces.
- **Firefox**: `manifest.firefox.json` script load order matches Chrome (`storage` → `lexora-constants` → `message-guards` → `proxy` → `lesson-capture` → …).
- **Tests**: `highlighter-alignment.test.js` for deterministic alignment; `protocol-storage.test.js` asserts the new `PENDING_ASK_AI` key.
- **CI hardening (e2e-smoke)**: New `extension/e2e/chromium-extension-context.js` adds CI-only Chromium flags (`--disable-dev-shm-usage`, `--no-sandbox`, `--disable-setuid-sandbox`); Playwright runs **single-worker, with retries** under CI; `getExtensionOrigin` waits up to **45 s** for the service worker on slow runners.
- **Capture extractor (CI fix)**: `collectHtmlBlocks` now falls back to `textContent` when `innerText` is empty (common in headless/Xvfb before layout runs), so deep capture is reliable on Linux runners.

### v1.9.0 — Phase 2: capture consistency, chat context, export UX

- **Capture**: `probePageContent` now shares the same `seen` dedup set as `extractPageContent`, so probe readiness and full capture agree on which blocks count.
- **Capture**: Published `LexoraCaptureExtractor.LIMITS` (`MIN_LESSON_CONTENT_CHARS`, `PROBE_BLOCK_CAP`, HTML/PDF readiness thresholds) so scoring lives in one place.
- **Chat**: Long lessons use **head + tail** truncation (`sidepanel/js/chat-context.js`) with an explicit middle-omitted marker, replacing simple beginning-only truncation.
- **Export**: If jsPDF isn't available, the export hint area now shows a clear error instead of silently doing nothing.

### v1.9.0 — Phase 1 (structural hardening, same release)

- **Background**: New `proxy.js` — streamed proxy responses capped (~4 MiB), IPv6 loopback allowlisted, shared validation.
- **Background**: New `lesson-capture.js` — monotonic operation IDs guard deep-capture timeouts and auto-capture navigation races.
- **Highlights**: `lexoraHighlightTarget { tabId, frameId }` with lesson storage; targeted highlight relay with multi-frame fallback.
- **Playback**: `playbackGen` on highlight/clear messages; content script ignores stale generations.
- **Audio**: Piper worker cancel/epoch; LRU-style trimming of Kokoro/Piper blob caches.
- **Content**: Overlay global `mousemove` / `mouseup` listeners removed on destroy.
- **Tooling**: ESLint `@eslint/js` recommended config, `extension/tests/proxy.test.js`, Node globals for `scripts/**/*.mjs`.

### v1.7.0

- **Stability**: Fixed capture flow issues that could leave the UI stuck on “Scanning…”.
- **Selected text → Read**: “Read” from the page selection bar now captures the selection into a “Selected Text” lesson and **auto-starts audio**.
- **Highlight accuracy**: More robust word alignment + recovery, plus an anchor so highlighting starts near the selected text.
- **Theme persistence + light mode contrast**: Settings persist correctly and light mode has improved readability for dropdowns and chat bubbles.
- **Refactor**: Sidepanel logic split into `sidepanel/js/*` modules (UI, settings, export, chat, utils) for maintainability.
- **Security hardening**:
  - Proxy fetch now **fail-closed** (extension-only senders, allowlisted origin, POST-only, capped body).
  - `postMessage` now uses **origin checks + handshake token** for mini-player bridge communications.
  - Auto-capture now requests **per-origin optional permissions** (no `<all_urls>` escalation).
- **Supply-chain integrity**: Piper remote models now include **pinned SHA-256** verification for both downloaded and cached assets.
- **Tests**: Added Vitest unit tests for capture cleanup + protocol/storage contracts, plus a Playwright extension smoke test.
- **Firefox compatibility path**:
  - Added `manifest.firefox.json` + `npm run build:firefox` to generate `dist/extension-firefox/manifest.json`.
  - Firefox background scripts now explicitly load `protocol.js`, `storage.js`, and `capture-clean.js` before `background.js`.
- **UI polish**:
  - Fixed mini-player play/pause bridge message-origin handling.
  - Fixed select/option visibility for model + voice dropdowns (especially in dark mode/macOS).
  - Fixed Content toolbar layout (`Summarize` button sizing + collapsed search field square).
  - Reduced capture-ready badge flicker by avoiding redundant status repaints while probing.

---

## Features

| Category | Feature |
|---|---|
| 📸 **Smart Capture** | Deep extraction from main frame + all iframes; captures hidden/collapsed content; deterministic cleanup removes boilerplate (cookie banners, nav, footers) |
| 🗣️ **Neural TTS** | Two local engines: **Kokoro** (natural, human-like) and **Piper** (offline, lightweight). Models download on first use and cache locally |
| 🎯 **Word Highlighting** | Word-level highlighting synced to audio playback; works across iframes; improved alignment + recovery on “messy” pages |
| 🖱️ **Read Selected Text** | Select any text on the page and use the floating action bar to **Read** it instantly (auto-opens panel + auto-plays) |
| 💬 **AI Chat** | Context-aware Q&A powered by any OpenAI-compatible endpoint (LM Studio, Ollama, OpenAI API, etc.) |
| 📄 **PDF Export** | One-click export of captured content to a formatted PDF via jsPDF |
| 🎛️ **Audio Controls** | Play / Pause / Resume, Previous / Next sentence, seek slider, adjustable speed (0.5x to 1.5x), 28+ voice options |
| 🧩 **Overlay UI** | Draggable, resizable, minimizable floating panel injected via Shadow DOM that won't break page styles |
| 🔒 **Privacy-First** | All TTS runs locally in Web Workers via WASM. No audio data leaves the browser. Chat is only sent to the endpoint *you* configure |
| 🌐 **Cross-Browser** | Chrome (Manifest V3) + Firefox (Manifest V3 with `browser_specific_settings`) |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Extension Platform** | Chrome/Firefox Manifest V3, Service Workers |
| **TTS (Kokoro)** | [Kokoro-82M ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), Transformers.js, WebAssembly |
| **TTS (Piper)** | [Piper](https://github.com/rhasspy/piper) `amy-low` + `hfc_female-medium` models (downloaded on demand from [HuggingFace](https://huggingface.co/rhasspy/piper-voices)), ONNX Runtime Web, `piper_phonemize` WASM |
| **AI Chat** | Any OpenAI-compatible `/v1/chat/completions` endpoint (proxied via background service worker) |
| **PDF Export** | [jsPDF](https://github.com/parallax/jsPDF) |
| **Highlighting** | Custom DOM `TreeWalker` + greedy word alignment algorithm in `content.js` |
| **UI** | Vanilla HTML/CSS/JS, Shadow DOM isolation, glassmorphism design, Inter + Manrope fonts |

---

## Project Structure

```
Lexora/
├── extension/                    # Browser extension (core product)
│   ├── manifest.json             # Manifest V3 config (Chrome)
│   ├── manifest.firefox.json     # Firefox fallback manifest source (uses background.scripts)
│   ├── background.js             # Service worker: dispatcher for proxy/capture/probe/highlight/Ask AI
│   ├── debug-log.js              # Shared safe-messaging helpers (sendMessageSafe, sendRuntimeMessageSafe)
│   ├── protocol.js               # ACTIONS enum + runtime message-shape validators
│   ├── storage.js                # Storage key registry (LexoraStorage.KEYS) + progress key helpers
│   ├── lexora-constants.js       # Cross-context numeric thresholds (MIN_CAPTURE_CONTENT_CHARS, …)
│   ├── message-guards.js         # Selection/lesson clamps, trusted-sender checks
│   ├── proxy.js                  # POST-only allowlisted proxy with streamed body cap
│   ├── lesson-capture.js         # Monotonic op IDs for deep-capture & auto-capture races
│   ├── capture-extractor.js      # Page extractor (HTML blocks + PDF text) with shared LIMITS
│   ├── capture-clean.js          # Deterministic text cleanup (no AI): dedup, boilerplate removal
│   ├── content.js                # Content bootstrap: loads extension/content/* modules in order
│   ├── content/                  # Modular content scripts (loaded by content.js)
│   │   ├── highlighter-alignment.js   # Pure chunk↔page word alignment helpers (unit-tested)
│   │   ├── content-highlighter.js     # Word/range highlighting + clear, with playbackGen guards
│   │   ├── content-overlay.js         # Draggable Shadow-DOM overlay host
│   │   ├── content-selection-bar.js   # Floating Read / Ask AI selection bar
│   │   └── content-router.js          # Runtime message router for content modules
│   ├── overlay.css               # Highlight + button styles for the host page
│   ├── icons/                    # Extension icons (48px, 128px)
│   ├── libs/
│   │   └── jspdf.umd.min.js     # PDF generation library
│   ├── e2e/                      # Playwright extension tests
│   │   ├── chromium-extension-context.js  # Shared launcher (CI-only --no-sandbox / --disable-dev-shm-usage)
│   │   ├── extension-smoke.spec.js
│   │   └── lexora-flows.spec.js          # Deep capture + selected-text auto-play flows
│   ├── tests/                    # Vitest unit tests
│   │   ├── capture-extractor.test.js
│   │   ├── chat-context.test.js
│   │   ├── highlighter-alignment.test.js
│   │   ├── message-guards.test.js
│   │   ├── protocol-storage.test.js
│   │   ├── proxy.test.js
│   │   └── …
│   └── sidepanel/                # Main UI + TTS engines
│       ├── sidepanel.html        # Panel UI (Chat, Content, Audio, Export, Settings tabs)
│       ├── sidepanel.css         # "Luminous Void" dark theme with glassmorphism
│       ├── sidepanel.js          # Orchestrator: audio engine + wires up sidepanel/js modules
│       ├── js/                   # Sidepanel modules (UI, settings, chat, export, utils)
│       │   ├── ui.js                  # Tabs, capture button, probe loop, lesson rendering
│       │   ├── settings.js            # Persistence, optional-permission requests, theme
│       │   ├── chat.js                # Q&A submit + history budget vs proxy body cap
│       │   ├── chat-context.js        # Head+tail lesson budgeting + fence tokens
│       │   ├── messaging.js           # ES-module facade over debug-log.js helpers
│       │   ├── export.js              # PDF export (jsPDF) with graceful fallback
│       │   ├── progress.js            # Reading-progress storage + legacy key migration (single-flight)
│       │   ├── utils.js
│       │   └── …
│       ├── kokoro-worker.js      # Web Worker for Kokoro neural TTS (ES module, job queue + epoch cancel + init timeout)
│       ├── kokoro.web.js         # Kokoro TTS + Transformers.js runtime bundle
│       ├── piper-worker.js       # Web Worker for Piper TTS (ONNX Runtime + on-demand model download)
│       ├── piper_phonemize.*     # Piper phonemize WASM module + data
│       └── ort*.wasm / ort*.js   # ONNX Runtime Web binaries (SIMD)
├── dist/                         # Generated build outputs (e.g. extension-firefox/)
├── server/                       # Reserved for future backend
├── BUGS.md                       # Detailed bug tracker with root-cause analyses
├── CHANGELOG.md                  # Per-version change log (mirrors manifest.json version)
└── .gitignore
```

### Key Modules

| File | Role |
|---|---|
| `background.js` | Service worker dispatcher. Routes `proxyFetch` (LLM API relay), `highlightWord` / `clearHighlight` (targeted via `lexoraHighlightTarget`, with all-frames fallback), `triggerDeepCapture`, `probeCapturable`, and selection actions (`captureText`, `askAiAboutText`). |
| `protocol.js` | Single source of truth for message `ACTIONS` and shape validators (`isHighlightWordRequest`, `isProxyFetchRequest`, …) shared by SW, content, and side panel. |
| `storage.js` | `LexoraStorage.KEYS` registry (`CURRENT_LESSON`, `HIGHLIGHT_TARGET`, `PENDING_ASK_AI`, `PROGRESS_INDEX`, …) and progress-key helpers. |
| `lexora-constants.js` | Cross-context numeric thresholds (e.g. `MIN_CAPTURE_CONTENT_CHARS`). Loaded by both the service worker (`importScripts`) and injected page scripts so guards & extractor can't drift. |
| `message-guards.js` | Trusted-sender checks, selection-text clamping, auto-capture lesson normalization. |
| `proxy.js` | POST-only allowlisted proxy with streamed response cap (~4 MiB) and 250 KB request body cap. |
| `lesson-capture.js` | Monotonic op IDs (`beginDeepCaptureOp`, `bumpAutoCaptureAndGetId`) so late async work cannot commit after timeout / superseding navigation. |
| `capture-extractor.js` | Page extractor (`extractPageContent`, `probePageContent`) + published `LIMITS` (`MIN_LESSON_CONTENT_CHARS`, `HTML_READY_CHARS`, `PDF_READY_CHARS`, `PROBE_BLOCK_CAP`). Falls back to `textContent` when `innerText` is empty (CI/headless). |
| `capture-clean.js` | Deterministic (non-AI) post-capture cleanup: Unicode normalization, whitespace compaction, consecutive duplicate removal, boilerplate pattern filtering. |
| `content.js` | Thin bootstrap that loads `extension/content/*` modules in order. |
| `content/highlighter-alignment.js` | Pure chunk↔page word alignment helpers (deterministic, unit-tested). |
| `content/content-highlighter.js` | DOM word/range highlighting + clear, with `playbackGen` guards so stale highlights don't survive navigation. |
| `content/content-overlay.js` | Draggable, resizable Shadow-DOM overlay host injected into the page. |
| `content/content-selection-bar.js` | Floating Read / Ask AI bar; guards `selection.rangeCount` before `getRangeAt(0)`. |
| `content/content-router.js` | Runtime message router for content modules. |
| `sidepanel.js` | Audio engine + TTS orchestration (Kokoro + Piper), caching/prefetch pipeline, seek/highlight sync, and integration glue for the modular UI. |
| `sidepanel/js/ui.js` | Tabs, capture button, probe loop (single async path via `sendRuntimeMessageSafe`), lesson rendering. Drains `lexoraPendingAskAi` on init and via `storage.onChanged`. |
| `sidepanel/js/chat.js` + `chat-context.js` | Chat submit + head+tail lesson budgeting; trims history (and last user message) so JSON stays under the proxy body cap. |
| `sidepanel/js/settings.js` | Settings persistence, per-origin optional permission requests, theme, sensitive-key handling (session vs local). |
| `sidepanel/js/progress.js` | Reading-progress storage with single-flight legacy-key migration. |
| `sidepanel/js/messaging.js` | ES-module facade over the shared `debug-log.js` helpers (`sendMessageSafe`, `sendRuntimeMessageSafe`). |
| `kokoro-worker.js` | ES-module Web Worker with internal job queue + epoch cancellation **and a 120 s `Promise.race` timeout around `from_pretrained`**. Downloads Kokoro-82M ONNX (~92 MB quantized) on first use. |
| `piper-worker.js` | Classic Web Worker running ONNX Runtime. Downloads Piper voice models on first use, caches in IndexedDB. Phonemizes via `piper_phonemize` WASM, then ONNX inference. |

---

## Installation & Setup

### Prerequisites

- **Chrome** ≥ 88 or **Firefox** ≥ 109
- (Optional) An OpenAI-compatible LLM server for the Chat feature (e.g., [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/))

### Chrome Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/MohamedHamed001/Lexora.git
   cd Lexora
   ```

2. Open Chrome and navigate to `chrome://extensions/`.

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **Load unpacked** and select the `extension/` directory.

5. Click the extension icon (✦) in your toolbar to open the overlay on the current page.

### Firefox Installation

1. Build the Firefox-ready folder (Firefox expects the filename `manifest.json`):
   ```bash
   npm run build:firefox
   ```

2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.

3. Click **Load Temporary Add-on** and select:
   - `dist/extension-firefox/manifest.json`

4. The sidebar panel will be available via the sidebar menu, or click the extension icon.

### Stable Firefox Release

If you only want the stable published build (no local setup), install from AMO:

- [Lexora: Webpage TTS on Firefox Add-ons](https://addons.mozilla.org/en-GB/firefox/addon/lexora-webpage-tts/)

---

## Usage

### 1. Capture a Page

1. Navigate to any webpage (article, lesson, documentation, etc.).
2. Click the **✦** extension icon to open the Lexora overlay.
3. Click **✨ Capture** to extract the page content.
4. The captured text appears in the **Content** tab, cleaned of navigation cruft and boilerplate.

### 2. Listen with Neural TTS

1. Switch to the **🎙 Audio** tab.
2. Choose your engine:
   - **Kokoro**: High-quality, natural voices. Downloads a ~92 MB model on first use (cached for future sessions).
   - **Piper**: Fast, lighter but more synthetic. Downloads a ~60 MB model on first use (cached in IndexedDB for future sessions).
3. Select a voice from the dropdown (28+ options for Kokoro).
4. Press **▶ Play**. Audio begins and words highlight on the page in real time.
5. Use the seek slider, speed control (0.5x to 1.5x), or the **⏮ / ⏭** buttons to navigate.

### 3. Chat with the Content

1. Switch to the **💬 Chat** tab.
2. Type a question and press Enter.
3. The AI answers based on the captured lesson content.
4. Requires a running LLM endpoint (configurable in Settings).

### 4. Export as PDF

1. Switch to the **⬇ Export** tab.
2. Click **⬇ Download PDF** to save the captured content as a formatted A4 PDF.

---

## Configuration

### Settings Tab (in extension)

| Setting | Description | Default |
|---|---|---|
| **Endpoint URL** | OpenAI-compatible chat completions API URL | `http://127.0.0.1:1234/v1/chat/completions` |
| **Model Name** | Model identifier sent in the API request | `local-model` |
| **API Key** | Bearer token for authentication (leave blank for local servers) | *(empty)* |

Settings are persisted via `chrome.storage.local` and survive browser restarts.

### Permissions model (important)

Lexora is designed around **least privilege**:

- **Default permissions**: `activeTab`, `scripting`, `storage`, `tabs`.
- **Optional permissions**:
  - `webNavigation` (for auto-capture / cross-frame highlight relay improvements when granted)
  - `permissions` (to request optional permissions at runtime)
- **Optional host permissions**: `http://*/*`, `https://*/*` (requested **per-origin** when needed).

When you enable **Auto-capture**, Lexora requests:

- `webNavigation`
- a **single origin pattern** derived from the current active tab (e.g. `https://example.com/*`)

If Lexora cannot derive a safe origin pattern, the request **fails closed** (auto-capture won’t enable).

### Engine Selection

Switch between **Kokoro** and **Piper** in the Audio tab's engine dropdown. The choice is saved to configuration.

### Voice Selection

- **Kokoro**: 28 voices across US/UK accents, male/female, each with a quality grade (A+ to F).
- **Piper**: Two voices — `Amy (low)` and `Google Female EN (medium)`. Downloaded on first use and cached locally.

### Content Security Policy

The extension's `extension_pages` CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

Why `'wasm-unsafe-eval'` is required: the local TTS engines (Kokoro, Piper) run via the ONNX Runtime, which compiles its WebAssembly module at runtime. Without `'wasm-unsafe-eval'`, `WebAssembly.compile()`/`instantiate()` is rejected by the CSP and neural TTS will not load. This relaxation is scoped to extension pages only; the host page's CSP is never modified, so it does not increase the attack surface of any visited site. We do **not** use `'unsafe-eval'` (no JavaScript `eval()`) and we do **not** load remote scripts.

### Web-accessible resources

The manifest exposes only `sidepanel/sidepanel.html` to host pages, because [extension/content.js](extension/content.js) mounts that page inside an iframe in the in-page overlay. All sidepanel JS, CSS, and helper modules are loaded transitively by that page from the extension origin and therefore do **not** need to be web-accessible. This minimizes the surface area for fingerprinting and keeps the trust boundary narrow.

To prevent host pages from probing for Lexora at a stable `chrome-extension://<id>/...` URL, the Chrome manifest sets `"use_dynamic_url": true` on the web-accessible resource ([Chrome 130+](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources)). The extension URL is regenerated per browser session, and content scripts always resolve it through `chrome.runtime.getURL()` so the iframe still loads correctly. Firefox does not yet support this flag, so the Firefox build retains the static URL.

### Chat proxy behavior

Chat requests are made from the sidepanel to the service worker using `proxyFetch`:

- The service worker **only** forwards requests to the configured endpoint origin (or localhost fallback).
- Only **POST** is allowed.
- Only a small allowlist of headers is forwarded.
- The body is JSON, capped at 250 KB.
- On failure, the proxy returns metadata (status code, content-type) and a sanitized error message. Raw response snippets are gated behind `globalThis.DEBUG` and are off by default to avoid leaking server-side details.

### Prompt-injection hardening

When chatting, captured page content is treated as **untrusted data**. The system prompt:

1. Wraps the lesson text inside unique fence tokens (`<<<LEXORA_SOURCE_START>>>` / `<<<LEXORA_SOURCE_END>>>`).
2. Strips any literal occurrence of those tokens from the captured text so a hostile page cannot forge a closing fence.
3. Instructs the model to ignore directives, role changes, or tool calls embedded inside the SOURCE CONTENT.

### API key persistence

By default, the chat API key is kept in `chrome.storage.session` (cleared when the browser closes). The "Remember Key" checkbox opts into persisting it to `chrome.storage.local`.

### Dev-tooling CVEs

`npm audit` is clean as of vitest 4.x. Earlier 2.x lines pulled in transitively-vulnerable `esbuild`/`vite` versions; those advisories applied to the dev server only and never shipped in the extension bundle. We track this surface to keep `npm audit` green.

---

## Architecture

```
┌─────────────┐     message      ┌──────────────────┐
│  Host Page   │ ◄──────────────► │ background.js    │
│ (content.js) │   highlight /    │ (Service Worker) │
│              │   capture relay  │                  │
└──────┬───────┘                  └────────┬─────────┘
       │                                   │
       │ iframe (Shadow DOM)               │ proxyFetch
       ▼                                   ▼
┌──────────────┐                  ┌──────────────────┐
│ sidepanel.js │                  │  LLM Endpoint    │
│  (Main UI)   │                  │ (LM Studio, etc) │
└──────┬───────┘                  └──────────────────┘
       │
       │ postMessage
       ▼
┌──────────────────────────┐
│ kokoro-worker.js         │ ◄── WASM / ONNX
│ piper-worker.js          │     (runs in Web Workers)
│ (Neural TTS Synthesis)   │
└──────────────────────────┘
```

**Key design decisions:**

- **Shadow DOM isolation**: The overlay is injected into the page via a closed Shadow DOM, preventing style conflicts with the host page.
- **Modular content scripts**: `content.js` is a small bootstrap that loads `extension/content/*` modules in a defined order. The same list is exported as `LEXORA_PAGE_SCRIPT_FILES` in `background.js` so the toolbar action injects exactly the same files.
- **Single source of truth for thresholds**: `lexora-constants.js` is shared by the service worker (`importScripts`) and every page-injected script, so `MIN_CAPTURE_CONTENT_CHARS` and friends can never silently drift between guards, the extractor, and background scoring.
- **Targeted highlight relay**: Highlights are sent to the exact `{ tabId, frameId }` recorded in `lexoraHighlightTarget` whenever possible; the active-tab + all-frames fan-out is now only a fallback (via `webNavigation.getAllFrames`).
- **Single-path message handlers**: The capture-readiness probe and chat history use one async path each (`sendRuntimeMessageSafe`, awaited) — no callback + `await` double handling that previously produced races/duplicate UI updates.
- **Storage-first one-shots**: Cross-context one-shots like “Ask AI from selection” are written to `storage.local.lexoraPendingAskAi`. The side panel drains them on init and via `storage.onChanged`, so requests survive a closed panel without needing a runtime message round-trip.
- **Capture timeouts everywhere**: Deep capture uses monotonic op IDs (`lesson-capture.js`) so late results from a superseded request can't commit; the Kokoro worker wraps `from_pretrained` in a 120 s `Promise.race` so a stuck model load surfaces a clear error instead of hanging the UI.
- **Web Worker TTS**: All neural inference runs off the main thread in dedicated Web Workers with job queues and epoch-based cancellation.
- **Prefetch pipeline**: Kokoro uses 1 main + 1 prefetch worker, caching up to 20 sentences ahead for gapless playback.
- **Cross-frame highlighting**: `background.js` can still broadcast highlight messages to every frame when no specific target is recorded, enabling highlighting inside iframes (e.g., Udacity lessons).
- **Deterministic cleanup**: Captured content is cleaned without AI to avoid truncation issues from local LLMs. Cleanup includes Unicode normalization, boilerplate pattern matching, and deduplication.
- **Progress storage**: Reading progress is stored using **hashed URL keys** plus a bounded `lexoraProgressIndex` (LRU-style); legacy-key migration is single-flight per key to avoid duplicate storage writes.
- **Layout-tolerant extractor**: `collectHtmlBlocks` falls back to `textContent` when `innerText` is empty (common in headless/Xvfb before layout runs), keeping CI extraction stable on Linux runners.

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository and clone your fork.
2. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feature/my-improvement
   ```
3. **Make your changes** following the existing code style (vanilla JS, no build step for the extension).
4. **Test** on both Chrome and Firefox:
   - Chrome: `chrome://extensions/` → Load unpacked
   - Firefox: `about:debugging` → Load Temporary Add-on
5. **Open a Pull Request** with a clear description of what changed and why.

### Guidelines

- Keep the extension zero-dependency on build tools (no webpack, no bundlers).
- All TTS processing must remain local. Do not add cloud TTS services.
- Test capture on diverse sites (Medium, Udacity, MDN, Wikipedia) before submitting.
- Update `BUGS.md` if you fix or discover a bug.
- If you change permissions/background behavior, keep both `manifest.json` (Chrome) and `manifest.firefox.json` (Firefox fallback) in sync.

---

## Maintenance & Quality

### Bug tracking

Use `BUGS.md` as the lightweight bug log. Each entry should include:

- Steps to reproduce
- Expected vs actual
- Root cause
- Fix (with file/line references)
- Regression test (unit/e2e), or rationale if not feasible


### Tests

- **Unit tests**: `npm test` (Vitest) covers:
  - deterministic capture cleanup (`capture-extractor.test.js`)
  - protocol / storage contracts (`protocol-storage.test.js`)
  - selection / lesson guards (`message-guards.test.js`)
  - chat-context budgeting + fence-token stripping (`chat-context.test.js`)
  - chunk↔page word alignment (`highlighter-alignment.test.js`)
  - proxy validation + body cap (`proxy.test.js`)
- **E2E**: `npm run test:e2e` runs the full Playwright suite (smoke + deep-capture + selected-text auto-play).
- **CI** (`.github/workflows/ci.yml`) runs three jobs on Ubuntu:
  - `lint-and-test` — `npm ci`, `npm run lint`, `npm test`, `npm audit --audit-level=high`.
  - `e2e-smoke` — installs Playwright + system deps, then `xvfb-run -a npx playwright test`. CI runs **single-worker with retries** and uses the shared launcher in `extension/e2e/chromium-extension-context.js` (`--no-sandbox`, `--disable-dev-shm-usage`, `--disable-setuid-sandbox`).
  - `build-firefox` — runs `npm run build:firefox` and verifies the generated `dist/extension-firefox/manifest.json` parses and ships the icon.

---

## License

This project is licensed under the **MIT License**.

```
MIT License

Copyright (c) 2026 Mohamed Hamed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
