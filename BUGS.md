# Lexora — Bugs & Root Cause Analysis

## Tracking checklist

### Bugs

- [x] **Seek slider / reset** — Fixed: seek keeps `audioCache`; progress counts recalculated from cache. See [Bug 1](#bug-1-seek-slider-is-slow--re-processes-all-audio).
- [x] **Voice change** — Fixed: resume after pause + voice change, synth only from current index forward, worker cancel/queue, reduced prefetch load. Residual: changing voice can still wait on in-flight Kokoro `generate()` (uncancellable); often ~6s first play vs longer on change. See [Bug 3](#bug-3-changing-voice-after-pause--slowresume).
- [ ] **Skipped sentences** — Text is captured but some sentences are never voiced (investigate sentence splitting, empty/whitespace drops, worker errors, or alignment with cleaned vs raw text).
- [x] **Model download size** — Fixed: wrong dtype. See [Model download size](#model-download-size-wrong-dtype--artifact-sizes).
- [x] **Word highlighting** — Fixed on Medium-style pages and Udacity (iframes + stale DOM + alignment + timing). See [Bug 2](#bug-2-highlight-only-covers-first-few-words-then-stops).
- [x] **High RAM / CPU** — Mitigated: fewer Kokoro workers (1 main + 1 prefetch), capped prefetch window (~20 sentences ahead). See [Performance](#performance--resource-usage).

### Capture / content

- [x] **Expandable / accordion text (e.g. Udacity)** — Capture now uses `textContent` for elements with no `offsetParent` so collapsed panel copy is included (`background.js` deep capture).

### To add / fix

- [ ] **Settings** — Remove cloud TTS from settings.
- [ ] **Audio** — Let the user choose between **Piper** and **Kokoro** in audio options.
- [ ] **Capture cleanup** — Prefer using the connected AI model first to clean and stylize captured text for readability; if no model is connected, fall back to existing non-model methods.
- [ ] **UI** — Remove the chat box from all screens except the chat screen.

---

## Bug 1: Seek slider is slow / re-processes all audio

### Status: **Fixed**

### What the user saw
Dragging the seek slider caused a long delay and the status showed full re-synthesis even when chunks were already cached.

### Root cause (historical)
The seek handler called `cancelAudio(true)`, which cleared `audioCache` and bumped `currentSynthesisId`, forcing all sentences to be synthesized again.

### Fix (implemented)
- Seek uses `cancelAudio(false)` — stops playback and invalidates in-flight IDs but **keeps cached blobs** (`sidepanel.js`).
- `synthesizeAll` recomputes `synthCompletedCount` from existing cache entries instead of assuming zero completed.
- Progress label uses `synthTotalCount` for the active batch where applicable.

---

## Bug 2: Highlight only covers first few words, then stops

### Status: **Fixed** (incl. Udacity + long articles)

### What the user saw
Only the first few words highlighted; wrong words sometimes highlighted; on Udacity, almost no match (lesson in iframe).

### Root causes (historical)
1. **`pageWords` stale after wrapping** — After `removeActiveSpans()` / DOM changes, entries pointed at detached nodes. **Fix:** Rebuild `pageWords` when starting alignment for a new chunk (`content.js`).
2. **Short lookahead** — Greedy alignment lost on long runs of extra DOM text. **Fix:** Increased lookahead in `alignChunkToPage` (e.g. 5 → 15).
3. **Uniform time → word index** — **Fix:** Character-weighted mapping from playback progress to word index (`sidepanel.js` `updateSeekBar`).
4. **Iframe lesson vs top frame** — Highlight ran only in the main frame; capture used `allFrames`. **Fix:** `content.js` injected / messaged across frames; `background.js` relays highlights via `webNavigation.getAllFrames`; overlay UI only on `window.top` (`manifest.json`: `webNavigation` permission).

---

## Bug 3: Changing voice after pause / slow resume

### Status: **Fixed** (functional); **known limitation** (latency)

### What the user saw
After pause + voice change, Resume did nothing or took a very long time; rapid voice changes worsened stalls.

### Root causes (historical)
1. **Paused path** — Cache cleared but no `speakNext()`; `currentAudioElement` null on Resume. **Fix:** `needsResynthOnResume` + Resume calls `speakNext()` (`sidepanel.js`).
2. **Re-synth scope** — Entire lesson re-queued after voice change. **Fix:** `synthesizeAll(voiceId, sentenceIdx)` only enqueues from current index; window capped (`PREFETCH_WINDOW`).
3. **Workers blocked on stale work** — Async worker handler serialized jobs; in-flight old-voice runs blocked new jobs. **Fix:** `kokoro-worker.js` internal job queue, `cancel` clears pending jobs, epoch discard + `{ type: 'discarded' }` so main thread clears placeholders and refills; `cancelAudio` posts `cancel` to all workers.

### Known limitation
`tts.generate()` cannot be aborted mid-call. After a voice change, playback may wait until any in-flight generation on that worker finishes (often tens of seconds for long chunks on WASM).

---

## Performance / resource usage

### Mitigations (implemented)
- **Worker count:** 1 main + 1 prefetch (was 1 + 5).
- **Prefetch window:** Only ~20 upcoming sentences are queued at a time; refilled as playback advances.

### Remaining tradeoff
Fewer / smaller batches reduce peak RAM but voice-change latency is still bounded by longest uncancelled synthesis.

---

## Architecture notes (not closed bugs)

### Message relay latency
Highlights: `sidepanel.js` → `background.js` → all frames’ `content.js`. Small per-message cost; very fast word changes can still stress the channel.

### `buildPageWords()` cost
Still O(page text). Rebuilt per spoken chunk when chunk text changes; long pages remain somewhat heavy.

### Highlight message volume
`updateSeekBar` skips unchanged word index; no extra debounce on the content script.

---

## Model download size: wrong dtype / artifact sizes

### Status: **Fixed**

### What was wrong
First-load download showed **~290 MB**, while **~87–92 MB** was expected for “quantized / Q8” Kokoro.

### Root cause
The worker was initialized with **`dtype: 'q4'`** in `sidepanel.js`. In Transformers.js / Kokoro, that selects **`onnx/model_q4.onnx`** on `onnx-community/Kokoro-82M-v1.0-ONNX`.

On that repo, **Q4 is not the small file**: `model_q4.onnx` is **~305 MB** (similar to full `model.onnx` at **~325 MB**). The **~92 MB** artifact is **`model_quantized.onnx`**, selected by **`dtype: 'q8'`** (suffix `_quantized` in the hub mapping).

So the confusion was **naming**: “q4” sounds smaller, but for this ONNX export the **quantized (q8) file is the small one**.

### Fix (implemented)
- `initWorker` / Kokoro init now uses **`dtype: 'q8'`** so downloads target **`model_quantized.onnx`** (~92 MB LFS size per Hugging Face API).

### Reference sizes (repo `onnx/`, approximate)
| Artifact | ~Size |
|----------|--------|
| `model.onnx` (fp32) | ~311 MB |
| `model_q4.onnx` | ~291 MB |
| `model_quantized.onnx` (q8) | ~88 MB |
| `model_q8f16.onnx` | ~82 MB |

(Voice `.bin` files under `voices/` are separate, small compared to the backbone.)

---

## Historical detail: original Bug 1 analysis snippet

Original seek bug pattern (for reference — **do not restore**):

```js
// WRONG (old):
cancelAudio(true);

// CORRECT (current):
cancelAudio(false);
```

---

## Historical detail: original Bug 2c (char-weighted highlight)

Character-weighted word index (conceptually as documented earlier) is **implemented** in `updateSeekBar` in `sidepanel.js`.
