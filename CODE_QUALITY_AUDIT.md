# Lexora Code Quality Audit

Date: 2026-04-29  
Scope reviewed: browser extension runtime (`extension/background.js`, `extension/content.js`, `extension/sidepanel/*`), shared helpers, tests, package scripts, README.

Checks run:

- `npm test`: passed, 8 Vitest tests.
- `npm run lint`: passed with 5 warnings, all in `extension/sidepanel/sidepanel.js`.

## 1. 🔴 Critical Issues (must fix)

### 1.1 The audio engine is still a monolith with global mutable state

`extension/sidepanel/sidepanel.js` is 1,419 lines and owns initialization, Kokoro loading, Piper loading, browser speech fallback, audio playback, caching, progress saving, keyboard shortcuts, mini-player integration, and cross-module exports. The file even documents the problem itself: lines 31-33 say historical module globals were kept to avoid runtime crashes, then lines 34-42 create local state that duplicates `state.js`.

Concrete examples:

- `extension/sidepanel/sidepanel.js:34-42` keeps `config`, audio element, chunk text, and highlight state as module globals.
- `extension/sidepanel/sidepanel.js:99-116` duplicates more runtime state and DOM aliases.
- `extension/sidepanel/js/state.js:12-35` defines TTS/audio/worker state, but most of that state is not actually authoritative; `sidepanel.js` uses parallel local variables instead.
- `extension/sidepanel/sidepanel.js:1408-1418` exposes `window.lexoraAudio` as a global service locator so other modules can reach back into the monolith.

Why this is production-critical: this design makes race conditions and state drift likely. A selected-text autoplay, a settings change, and an in-flight TTS worker load can all mutate overlapping state through different paths. At 10x feature growth, this will become the main source of regressions.

Fix: extract a real `AudioController` module with explicit state ownership. `settings.js`, `ui.js`, and `miniplayer-bridge.js` should depend on controller methods passed during initialization, not `window.lexoraAudio`.

### 1.2 The main user flows are not protected by active E2E tests

The two meaningful browser-flow tests in `extension/e2e/lexora-flows.spec.js` are skipped:

- `extension/e2e/lexora-flows.spec.js:59` skips deep capture updating the sidepanel.
- `extension/e2e/lexora-flows.spec.js:118` skips selected text -> Read.

The active test suite is only 8 unit tests (`npm test`), mainly around capture cleanup, protocol/storage helpers, and chunk splitting. That is useful, but it does not cover service-worker messaging, content-script injection, overlay behavior, permission degradation, cross-frame relay, TTS startup/cancel, or selected-text autoplay.

Why this is production-critical: the riskiest parts of this product are browser API integration and async cross-context flows. Those are exactly the parts currently skipped.

Fix: unskip or replace these with deterministic local-page tests. Use `page.setContent()` or a local HTTP server instead of `https://example.com`, then validate capture, selection relay, sidepanel storage sync, and blocked-page behavior in CI.

### 1.3 Capture extraction logic is duplicated and inconsistent

There are at least three independent capture/probe implementations:

- Deep capture injected function in `extension/background.js:247-358`.
- Readiness probe injected function in `extension/background.js:447-496`.
- Auto-capture exposed function in `extension/content.js:893-940`.

They use overlapping selector lists and normalization rules, but not the same exact behavior. For example, deep capture includes PDF text-layer extraction (`background.js:305-340`), while `window.lexoraCaptureText` does not (`content.js:893-940`). The probe uses a separate heuristic threshold (`background.js:486-494`) that can report "ready" for content the actual capture path later handles differently.

Why this is production-critical: duplicated extraction rules will create inconsistent user-visible behavior: "Ready" can disagree with "Capture", auto-capture can save lower-quality content than manual capture, and PDF behavior depends on which path ran.

Fix: move extraction into a shared injected function or shared source string generated from one module. Expose `extractPageContent(document, location)` and `probePageContent(document, location)` from the same implementation and test it against HTML, PDF.js text layers, hidden nodes, LMS-like nested content, and nav/footer noise.

## 2. 🟡 Major Improvements (should fix)

### 2.1 Message handling lacks schema validation

`extension/background.js:539-563` routes messages by string action, but payloads are mostly trusted after the action is selected. Examples:

- `handleSelectionActions` uses `request.text` and `sender.tab.id` without validating both exist (`background.js:205-216`).
- `highlightWord` messages are relayed to all frames without validating `chunkText` or `wordIndex` (`background.js:547-549`, `content.js:779-780`).
- Chat assumes an OpenAI-compatible response shape at `extension/sidepanel/js/chat.js:45-47` (`resp.data.choices[0].message.content`).

The proxy endpoint is relatively well hardened (`background.js:82-176`), but the rest of the internal protocol is not.

Fix: add protocol guards such as `isProxyFetchRequest`, `isHighlightWordRequest`, `isCaptureTextRequest`, and validate response shapes before dereferencing. Keep unknown or malformed messages fail-closed with useful errors.

### 2.2 Error handling is inconsistent and often silent

The code uses many empty `catch` blocks in runtime-critical paths:

- Import failures in the service worker are swallowed (`background.js:2-8`).
- Highlight relay frame failures are swallowed (`background.js:184-199`).
- Capture fallback errors can lose diagnostic detail (`background.js:385-406`).
- Content-script DOM mutation and message handling errors are swallowed (`content.js:584-591`, `content.js:751-778`).
- Export failure only logs to console and gives the user no feedback (`extension/sidepanel/js/export.js:128`).

Some suppression is justified in browser extensions, but the current style erases operational insight. If a host page blocks injection, a worker fails, or a PDF extraction path breaks, the user and developer often get only a generic fallback.

Fix: introduce a tiny `reportDebug(event, details)`/`reportUserError(target, message)` utility. Keep noisy frame failures low-level, but preserve structured reasons for capture, export, worker load, and chat response failures.

### 2.3 Content script mixes overlay UI, selection actions, capture, and highlighting

`extension/content.js` is 942 lines. It handles:

- Overlay creation and styles (`content.js:45-388`).
- Drag/minimize behavior (`content.js:343-437`).
- Word indexing and alignment (`content.js:439-730`).
- Runtime message handling (`content.js:745-784`).
- Selection action bar (`content.js:794-891`).
- Auto-capture extraction (`content.js:893-940`).

These are separate responsibilities with different risk profiles. The highlight logic mutates host-page text nodes (`content.js:584-642`), while overlay creation injects a high-z-index Shadow DOM iframe (`content.js:51-70`). Keeping them in one closure makes it hard to test either behavior independently.

Fix: split into modules or at least factory functions:

- `overlay-controller`: create/toggle/destroy/minimize/drag.
- `selection-toolbar`: selected text actions.
- `highlighter`: word index, alignment, wrapping, cleanup.
- `capture-extractor`: shared extraction logic.
- `message-router`: validated runtime messages.

### 2.4 UI modules still use hidden global coupling

Modularization has started, but modules still reach through globals:

- `settings.js` calls `window.lexoraAudio` repeatedly (`extension/sidepanel/js/settings.js:122-133`, `151-158`, `189-207`).
- `ui.js` calls `window.lexoraAudio.resetNarrationForNewLesson()` (`extension/sidepanel/js/ui.js:291-293`) and dynamically imports chat from event handlers (`ui.js:200-238`).
- `sidepanel.js` initializes UI/chat/export before settings (`sidepanel.js:19-22`, `1325`), but settings then reaches back into audio initialization through the global.

This is service-locator coupling. It works at small scale but makes initialization order fragile and makes unit testing hard.

Fix: create a sidepanel composition root:

```js
const audio = createAudioController({ state, dom, browserAPI });
initUI({ state, dom, audio, chat });
initSettings({ state, dom, audio });
initChat({ state, dom, apiClient });
```

### 2.5 Lint configuration allows warnings to accumulate

`package.json:7` runs ESLint with `--max-warnings 9999`, and lint currently reports 5 warnings in `sidepanel.js`:

- Unused functions/constants at `sidepanel.js:492`, `558`, `577`, `960`, `1084`.

This is not a functional failure, but it weakens lint as a quality gate. In production systems, unused code in a monolithic async controller is a real maintenance smell because reviewers cannot tell whether it is dead, pending, or accidentally disconnected.

Fix: remove dead code or mark intentional parameters with `_`. Then set `--max-warnings 0`.

### 2.6 The chat path has fragile response parsing and unbounded lesson context

`extension/sidepanel/js/chat.js:36-43` sends the entire captured lesson content plus chat history on every request. `chat.js:45-47` assumes `choices[0].message.content` exists.

Risks:

- Large captures can exceed local model/server context limits or the proxy body cap (`background.js:119-121`) without a clear preflight warning.
- Non-OpenAI-compatible endpoints, streaming endpoints, or error-shaped JSON can throw inside the callback.
- A malicious or poor-quality captured page can inject prompt instructions into the lesson content. This is not classic code execution, but it is prompt-injection risk for the chat feature.

Fix: add a chat client layer with response validation, content-length budgeting, summarization/chunking for large lessons, and a system prompt that explicitly treats lesson text as untrusted content.

### 2.7 Search highlighting only marks the first match per text node

`markMatches` in `extension/sidepanel/js/utils.js:159-177` uses `lower.indexOf(query)` once per text node, so repeated matches in the same node are not highlighted. That is minor for small content but weakens search usability on long lessons.

Fix: split each text node around all non-overlapping matches, not just the first.

## 3. 🟢 Minor Improvements (nice to have)

### 3.1 Documentation is strong at product level but weak at internal contracts

`README.md` gives a good product overview and project map, but internal contracts are mostly implicit. There is no short architecture decision record for:

- Why capture runs in both background-injected code and content script.
- Message protocol ownership and allowed payloads.
- Worker lifecycle and cache invalidation rules.
- Permission model and degraded behavior.

Fix: add `docs/architecture.md` with a sequence diagram for capture, selected-text read, TTS playback, and chat proxy.

### 3.2 Some comments explain history instead of current design

The comment at `sidepanel.js:31-33` explains that old globals were kept after partial refactors. That is useful as a warning, but it should not remain as a permanent design explanation. Similarly, `settings.js:204` says Kokoro metadata "will be imported or managed in audio.js", but there is no `audio.js`.

Fix: convert historical comments into issues or remove them after the refactor.

### 3.3 Inline styles reduce consistency

There are large inline CSS strings in `content.js:53-68`, `content.js:74-246`, and `content.js:800-823`. For Shadow DOM this can be acceptable, but it makes visual changes harder to review and test. The sidepanel uses CSS files, while content script UI uses JS strings.

Fix: keep Shadow DOM style injection, but move CSS strings into named template constants or importable text assets during build.

### 3.4 `mdToHtml` is a risky unused duplicate

`extension/sidepanel/js/utils.js:3-39` builds HTML strings. The safer `mdToDomFragment` path starts at `utils.js:76` and is what the UI uses. Even though `mdToHtml` escapes before inline replacement, having an HTML-string renderer next to a safe DOM renderer invites future misuse.

Fix: remove `mdToHtml` if unused, or make it private to tests only. Prefer the DOM renderer everywhere.

### 3.5 Test utility files are inconsistent

`extension/tests/test-utils.js` appears to be a standalone console script, while the actual test suite uses Vitest. That creates ambiguity about what is maintained.

Fix: migrate it into a Vitest file or delete it.

## 4. 💡 Suggested Refactoring Plan (step-by-step, prioritized)

### Step 1: Make tests meaningful before moving code

1. Unskip or replace the skipped E2E tests in `extension/e2e/lexora-flows.spec.js`.
2. Add local deterministic pages for: normal article capture, nested duplicate content, PDF.js-like text layer, selected text read, blocked URL, and chat proxy failure.
3. Add regression tests for `splitIntoChunks`, `markMatches`, and capture extraction edge cases.
4. Change lint to `--max-warnings 0` after removing current warnings.

### Step 2: Extract shared capture/probe logic

1. Create `extension/capture-extractor.js` with pure functions for normalization, candidate selection, PDF text-layer extraction, dedupe, and result scoring.
2. Use the same implementation from manual deep capture, readiness probe, and auto-capture.
3. Keep browser-specific injection as a thin adapter only.

### Step 3: Break `content.js` into isolated controllers

1. Extract `createOverlayController`.
2. Extract `createHighlighter`.
3. Extract `createSelectionToolbar`.
4. Keep message routing as the only top-level orchestration.
5. Add unit tests for highlighter alignment using DOM fixtures.

### Step 4: Replace `window.lexoraAudio` with explicit dependencies

1. Create `sidepanel/js/audio-controller.js`.
2. Move Kokoro/Piper/system speech state into that controller.
3. Remove duplicate TTS fields from `state.js` or make them the single source of truth.
4. Pass the controller into `initUI`, `initSettings`, and `initMiniPlayerBridge`.

### Step 5: Harden protocol and error handling

1. Expand `protocol.js` from action constants into action-specific validators.
2. Validate all incoming messages and all chat response shapes.
3. Add structured debug logging for failed capture, failed export, worker initialization, and proxy responses.
4. Show user-facing errors for export and chat parse failures.

### Step 6: Improve scalability of chat and TTS

1. Add lesson-size budgeting before chat requests.
2. Chunk or summarize long lessons.
3. Treat captured lesson content as untrusted prompt data.
4. Add worker lifecycle tests around cancel, engine switch, dtype switch, and autoplay retry.

## 5. 🧠 Overall Assessment

Rating: **5.5 / 10**

The codebase is functional and shows real engineering progress: security hardening exists in the proxy (`background.js:82-176`), rendering mostly avoids `innerHTML`, deterministic capture cleanup is tested, and the sidepanel has started moving into modules. The README is unusually clear for a small extension project.

The main issue is that the highest-risk behavior is still concentrated in large stateful scripts. `sidepanel.js`, `content.js`, and `background.js` are doing too much, share implicit state through globals and browser storage, and have many silent failure paths. The tests currently validate helper behavior, not the production-critical browser flows. Under 10x scale, the current architecture will slow every feature: adding another TTS engine, another capture mode, or richer chat memory would increase coupling and regression risk unless the state ownership and protocol boundaries are fixed first.

This is not a rewrite situation. The right move is staged extraction: first lock behavior with E2E tests, then extract capture, content-script controllers, and the audio controller behind explicit interfaces.
