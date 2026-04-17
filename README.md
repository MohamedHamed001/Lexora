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

## Features

| Category | Feature |
|---|---|
| 📸 **Smart Capture** | Deep extraction from main frame + all iframes; captures hidden/collapsed content; deterministic cleanup removes boilerplate (cookie banners, nav, footers) |
| 🗣️ **Neural TTS** | Two local engines: **Kokoro** (natural, human-like, ~92 MB model) and **Piper** (instant startup, lightweight ONNX) |
| 🎯 **Word Highlighting** | Character-weighted word-level highlighting synced to audio playback; works across iframes; smooth scrolling follows the spoken word |
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
| **TTS (Piper)** | [Piper](https://github.com/rhasspy/piper) `amy-low` model, ONNX Runtime Web, `piper_phonemize` WASM |
| **AI Chat** | Any OpenAI-compatible `/v1/chat/completions` endpoint (proxied via background service worker) |
| **PDF Export** | [jsPDF](https://github.com/parallax/jsPDF) |
| **Highlighting** | Custom DOM `TreeWalker` + greedy word alignment algorithm in `content.js` |
| **UI** | Vanilla HTML/CSS/JS, Shadow DOM isolation, glassmorphism design, Inter + Manrope fonts |

---

## Project Structure

```
Lexora/
├── extension/                    # Browser extension (core product)
│   ├── manifest.json             # Manifest V3 config (Chrome + Firefox)
│   ├── background.js             # Service worker: capture orchestration, message relay, API proxy
│   ├── content.js                # Content script: overlay injection, word highlighting, drag logic
│   ├── capture-clean.js          # Deterministic text cleanup (no AI): dedup, boilerplate removal
│   ├── overlay.css               # Highlight + button styles for the host page
│   ├── icons/                    # Extension icons (48px, 128px)
│   ├── libs/
│   │   └── jspdf.umd.min.js     # PDF generation library
│   └── sidepanel/                # Main UI + TTS engines
│       ├── sidepanel.html        # Panel UI (Chat, Content, Audio, Export, Settings tabs)
│       ├── sidepanel.css         # "Luminous Void" dark theme with glassmorphism
│       ├── sidepanel.js          # App logic: capture, chat, audio engine, PDF export, settings
│       ├── kokoro-worker.js      # Web Worker for Kokoro neural TTS (ES module, job queue + epoch cancel)
│       ├── kokoro.web.js         # Kokoro TTS + Transformers.js runtime bundle
│       ├── piper-worker.js       # Web Worker for Piper TTS (ONNX Runtime)
│       ├── piper_phonemize.*     # Piper phonemize WASM module + data
│       ├── ort*.wasm / ort*.js   # ONNX Runtime Web binaries
│       └── amy-low.onnx*         # Bundled Piper voice model + config
├── server/                       # Reserved for future backend
├── BUGS.md                       # Detailed bug tracker with root-cause analyses
└── .gitignore
```

### Key Modules

| File | Role |
|---|---|
| `background.js` | Service worker handling three message types: `proxyFetch` (LLM API relay), `highlightWord` / `clearHighlight` (broadcast to all frames), `triggerDeepCapture` (page extraction) |
| `content.js` | Injects the draggable overlay host (Shadow DOM), builds a `pageWords` index via `TreeWalker`, performs greedy chunk-to-page word alignment, wraps matched words in `<span>` for highlighting |
| `sidepanel.js` | ~1100 lines covering tab management, capture workflow, markdown rendering, AI chat, dual TTS engine management (Kokoro + Piper), audio caching/prefetch pipeline, seek/highlight sync, PDF export, settings persistence |
| `kokoro-worker.js` | ES module Web Worker with internal job queue + epoch-based cancellation. Downloads Kokoro-82M ONNX model (~92 MB quantized) from Hugging Face Hub on first use |
| `piper-worker.js` | Classic Web Worker running ONNX Runtime with bundled `amy-low` model. Handles phonemization via `piper_phonemize` WASM, then ONNX inference |
| `capture-clean.js` | Deterministic (non-AI) post-capture cleanup: Unicode normalization, whitespace compaction, consecutive duplicate removal, boilerplate pattern filtering |

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

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.

2. Click **Load Temporary Add-on**.

3. Select `extension/manifest.json`.

4. The sidebar panel will be available via the sidebar menu, or click the extension icon.

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
   - **Piper**: Instant startup, lighter but more synthetic.
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

### Engine Selection

Switch between **Kokoro** and **Piper** in the Audio tab's engine dropdown. The choice is saved to configuration.

### Voice Selection

- **Kokoro**: 28 voices across US/UK accents, male/female, each with a quality grade (A+ to F).
- **Piper**: Bundled `amy-low` English voice.

### Content Security Policy

The extension requires `'wasm-unsafe-eval'` for ONNX Runtime WASM execution. This is scoped to extension pages only and does not affect the host page.

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
- **Web Worker TTS**: All neural inference runs off the main thread in dedicated Web Workers with job queues and epoch-based cancellation.
- **Prefetch pipeline**: Kokoro uses 1 main + 1 prefetch worker, caching up to 20 sentences ahead for gapless playback.
- **Cross-frame highlighting**: `background.js` relays highlight messages to every frame via `webNavigation.getAllFrames`, enabling highlighting inside iframes (e.g., Udacity lessons).
- **Deterministic cleanup**: Captured content is cleaned without AI to avoid truncation issues from local LLMs. Cleanup includes Unicode normalization, boilerplate pattern matching, and deduplication.

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
