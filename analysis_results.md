# Lexora — Feature Audit & Roadmap

> Deep analysis based on reading every source file in the repository.

---

## 🗑️ Features to Remove / Cut

### 1. Debug Console (dead UI)
**Files:** [sidepanel.html:L117-120](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.html#L117-L120), [sidepanel.js:L20-33](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L20-L33)

The debug console (`#debug-console`) is permanently hidden — `logDebug()` sets `display: none` on every call (line 25). It was useful during development but now it's dead weight: ~15 lines of JS + HTML that never render. Remove entirely and replace with `console.debug()` guarded by a `DEBUG` flag.

---

### 2. "Refresh Voices" Button (confusing for users)
**File:** [sidepanel.html:L109](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.html#L109), [sidepanel.js:L646-L651](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L646-L651)

The `↻ Refresh voices` button only matters for the Web Speech API system voice edge case. Since 99% of users use Kokoro or Piper (which have hardcoded voice lists), this button does nothing useful for them. It adds UI clutter and confusion. Remove it, or at minimum hide it when Kokoro engine is selected.

---

### 3. System / Web Speech API Voice Fallback (within Piper engine)
**Files:** [sidepanel.js:L685-L767](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L685-L767) (novelty voice filtering, Google voice discovery)

When the Piper engine is selected, the voice picker only shows 2 Piper voices — it never shows system voices. Yet ~80 lines of code handle system voice discovery (`findGoogleFemaleEnVoice`, `findGoogleFemaleEnglishVoice`, `findGoogleVoice`, `isLikelyNoveltyOrEffectVoice`). This code path is a remnant from when system voices were mixed into the Piper picker. It's unreachable in the current flow. Remove or clearly scope it behind an "advanced" toggle.

---

### 4. `server/` Directory (empty placeholder)
**Path:** `/server/` — an empty directory in the repo marked "Reserved for future backend." Provides no value and creates a false expectation of backend functionality. Remove it; re-add when there's actual code.

---

### 5. Duplicate `SpeechSynthesisUtterance` Fallback Path
**File:** [sidepanel.js:L1524-L1554](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L1524-L1554)

The "Native Speech Fallback" `else` branch at the end of `speakNext()` is almost identical to the system-voice path inside the Piper engine handler (L1427-L1467). Two near-identical 30-line blocks. Refactor into a single `speakWithSystemVoice(text, voice, rate)` function.

---

### 6. `popOutBtn` / Overlay-to-Sidepanel Toggle
**File:** [sidepanel.js:L61-L74](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L61-L74)

This button sends `toggleOverlay` to the content script and then calls `window.close()`. But since sidepanel runs inside an iframe overlay (not a standalone popup), `window.close()` doesn't behave predictably across browsers. This is a confusing UX artifact. Consider removing it or rethinking the paradigm.

---

## 🔧 Features to Improve

### 1. `sidepanel.js` is a 1,680-Line Monolith
**File:** [sidepanel.js](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js)

This single file handles: tab switching, capture, markdown rendering, AI chat, Kokoro TTS (workers, cache, synthesis queue), Piper TTS (workers, cache, synthesis queue), audio playback, seek bar, word highlighting sync, voice discovery, PDF export, settings persistence, and mini-player sync.

> [!IMPORTANT]
> **Split into modules.** Even without a bundler, you can use ES module `<script type="module">` and `import/export`. Suggested split:
> - `tts-kokoro.js` — Kokoro worker management, cache, synthesis queue
> - `tts-piper.js` — Piper worker management, cache, synthesis queue  
> - `audio-playback.js` — `playFromBlob`, seek bar, word highlighting sync
> - `chat.js` — AI chat logic
> - `capture.js` — Capture button, lesson application
> - `settings.js` — Config persistence
> - `pdf-export.js` — PDF generation

---

### 2. Chat Is Extremely Basic (Single-Turn, No History)
**File:** [sidepanel.js:L164-L208](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L164-L208)

Current chat sends a single system + user message every time. No conversation history is maintained. Each question is answered in isolation, which makes follow-up questions impossible ("What about the second point?" → AI has no context).

> [!TIP]
> Maintain a `chatHistory[]` array. Append each user/assistant pair. Send the full history on each request (up to a token limit). This is a major UX improvement for studying.

---

### 3. PDF Export Produces Bare-Bones Output
**File:** [sidepanel.js:L1557-L1588](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L1557-L1588)

The PDF is plain Helvetica text on white with no formatting whatsoever — headings are stripped (`replace(/^#{1,6}\s+/gm, '')`), bold/italic is removed, and code blocks are lost. For a "study companion," this produces a much worse artifact than the original webpage.

**Improve by:**
- Preserving heading hierarchy (larger font, bold, spacing)
- Rendering bullet lists with indentation
- Keeping bold/italic/code formatting
- Adding page numbers, header/footer with title
- Optional: use a better PDF library like `pdf-lib` that supports rich text

---

### 4. Capture Selectors Are Hardcoded to Udacity
**File:** [background.js:L69-L77](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/background.js#L69-L77)

```js
'.index--body--299_C',
'.atom-content',
'.concept-content',
"div[class*='index-module--content']",
"div[class*='text-lesson']",
"div[class*='video-lesson']",
```

These are Udacity-specific CSS class selectors baked into the core capture logic. On non-Udacity sites they're harmless (no matches), but they show the capture was designed for one platform. The generic selectors (`h1,h2,h3,h4,p,li`) do most of the work.

**Improve by:** Moving site-specific selectors into a configurable "site recipes" system, or removing them entirely since the generic selectors + `TreeWalker` approach works well.

---

### 5. Capture Misses `<article>`, `<section>`, `<main>`, `<blockquote>`, `<pre>`, `<code>`
**File:** [background.js:L69-L77](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/background.js#L69-L77)

The capture selectors don't include semantic HTML elements that most modern sites use. Articles on Medium, dev.to, MDN all use `<article>` and `<main>`. Missing `<pre>` and `<code>` means code blocks in documentation are silently dropped.

---

### 6. Word Highlighting Rebuilds the Page Index on Every New Chunk
**File:** [content.js:L447-L469](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/content.js#L447-L469)

`buildPageWords()` walks the entire DOM tree via `TreeWalker` every time a new TTS chunk starts playing. For a long page with 50+ chunks, this means 50+ full DOM walks. Cache the page index and only rebuild when the URL changes or a mutation observer detects structural changes.

---

### 7. No Error Boundary for AI Chat
**File:** [sidepanel.js:L177-L197](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.js#L177-L197)

If the configured LLM endpoint is unreachable, the error message is `❌ Error: Could not reach API.` — with no guidance on how to fix it. Users who haven't set up LM Studio/Ollama will see this immediately. Add a first-run experience that explains the chat feature requires a local LLM server, with links.

---

### 8. Branding Inconsistency
**Files:** [manifest.json:L3](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/manifest.json#L3), [sidepanel.html:L6](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.html#L6), [sidepanel.html:L18](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.html#L18), [content.js:L283](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/content.js#L283)

| Location | Name Used |
|---|---|
| manifest.json `name` | "AI-Study Companion" |
| HTML `<title>` | "AI-Study Companion" |
| Header in sidepanel | "✦ AI-Study Companion" |
| Overlay drag bar | "Lexora Companion" |
| README | "Lexora" |
| Sidebar title (Firefox) | "Lexora Study Companion" |

> [!WARNING]
> The extension is called **three different names** across its own UI. Unify everything to "Lexora" — manifest name, HTML title, headers, etc.

---

### 9. Speed Slider Max is Too Low
**File:** [sidepanel.html:L96](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/sidepanel/sidepanel.html#L96)

Max speed is 1.5×. Many TTS users (especially for studying) want 1.75× or 2×. Kokoro and Piper both use `HTMLAudioElement.playbackRate` which supports up to 16×. Bump the max to at least 2.5×.

---

### 10. No Keyboard Shortcuts
The extension has no keyboard shortcuts at all. For a study tool, this is a significant UX gap:
- `Space` → Play/Pause
- `←` / `→` → Previous/Next sentence
- `Ctrl+Shift+C` → Capture page

---

### 11. `web_accessible_resources` is Overly Broad
**File:** [manifest.json:L32-L45](file:///Users/mohameda.hamed/Documents/ScrapingScript/extension/manifest.json#L32-L45)

```json
"matches": ["<all_urls>"]
```

This exposes all extension resources to every website. A malicious page could probe for Lexora's existence. Restrict to `["<all_urls>"]` only if needed for iframe injection, or scope to specific resource patterns.

---

## ➕ Features to Add

### 1. 🔥 Conversation History in Chat (High Impact, Low Effort)
Maintain `chatHistory[]` and send it with each API call. Enables follow-up questions, which is the #1 expected behavior for a chat-with-content feature. ~20 lines of code.

---

### 2. 📋 Reading Progress / Bookmarks
Save `sentenceIdx` to `chrome.storage.local` per URL. When the user returns to a page, offer "Resume from where you left off?" This is essential for long-form content (30-min articles, multi-part lessons).

---

### 3. 🌍 Multi-Language TTS Support
Kokoro supports multiple languages. Piper has models in 30+ languages. Add a language selector or auto-detect the page language and select an appropriate voice model. Currently English-only, which limits the audience.

---

### 4. 📝 Note-Taking / Annotation
Add a simple note-taking tab where users can jot down thoughts while listening. Notes should be persisted per-URL in `chrome.storage.local`. This pairs naturally with the study companion concept.

---

### 5. 🔍 Text Search Within Captured Content
The Content tab shows captured text but has no search functionality. Add `Ctrl+F` style search with highlighting. Simple to implement, very useful for long captures.

---

### 6. 📊 Study Statistics
Track and display: pages captured, total listening time, words read, chat questions asked. Store in `chrome.storage.local`. Gamification increases engagement — even a simple "Today: 45 min studied" counter would help.

---

### 7. 🎨 Light Theme Option
The "Luminous Void" dark theme is beautiful, but some users study in well-lit environments. Add a light/dark toggle. CSS custom properties are already used throughout, so this is a straightforward addition.

---

### 8. 📑 Content Summarization
Before reading 5,000 words, users may want a quick TL;DR. Add a "Summarize" button that sends the captured content to the configured LLM endpoint for a bullet-point summary. Low effort since the LLM proxy is already built.

---

### 9. ⌨️ Text Selection → Quick Actions
When the user selects text on the page, show a floating Lexora action: "Read this aloud", "Ask about this", "Define this". This is a high-value interaction pattern for study tools.

---

### 10. 📤 Export Improvements
- **Markdown export** (`.md` file download) — trivial since content is already markdown
- **Copy to clipboard** button
- **Share link** that encodes the captured content (Base64 + URL)

---

### 11. 🧪 Automated Testing
Zero tests exist. At minimum:
- Unit tests for `capture-clean.js` (deterministic logic, easy to test)
- Unit tests for `splitIntoChunks()` and `mdToHtml()`
- Integration test: capture a known HTML fixture, verify output

---

### 12. 🔄 Auto-Capture on Navigation
Option to automatically capture when the user navigates to a new page (especially useful for LMS platforms where lessons auto-advance). Watch for `webNavigation.onCompleted` events and trigger capture if the domain matches a user-configured list.

---

## Priority Matrix

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Fix branding inconsistency | 15 min | High (professionalism) |
| 🔴 P0 | Remove dead debug console | 10 min | Medium (clean code) |
| 🔴 P0 | Add conversation history to chat | 30 min | Very High (UX) |
| 🟠 P1 | Split sidepanel.js into modules | 2-3 hrs | High (maintainability) |
| 🟠 P1 | Improve PDF export formatting | 1-2 hrs | High (utility) |
| 🟠 P1 | Add keyboard shortcuts | 1 hr | High (UX) |
| 🟠 P1 | Expand capture selectors | 30 min | Medium (compatibility) |
| 🟡 P2 | Add reading progress/bookmarks | 1-2 hrs | High (retention) |
| 🟡 P2 | Content summarization button | 1 hr | Medium (utility) |
| 🟡 P2 | Bump speed max to 2.5× | 5 min | Medium (UX) |
| 🟡 P2 | Cache page word index | 1 hr | Medium (performance) |
| 🟢 P3 | Note-taking tab | 2-3 hrs | Medium (differentiation) |
| 🟢 P3 | Light theme toggle | 1-2 hrs | Medium (accessibility) |
| 🟢 P3 | Text selection quick actions | 2-3 hrs | Medium (engagement) |
| 🟢 P3 | Study statistics | 2-3 hrs | Low (engagement) |
| 🟢 P3 | Automated testing | 3-4 hrs | High (reliability) |
