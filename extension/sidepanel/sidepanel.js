// sidepanel.js — Lexora Kokoro Edition
import { state } from './js/state.js';
import { dom } from './js/dom.js';
import { encodeWAV, splitIntoChunks } from './js/utils.js';
import { initUI } from './js/ui.js';
import { initChat } from './js/chat.js';
import { initExport } from './js/export.js';
import { initMiniPlayerBridge } from './js/miniplayer-bridge.js';
import { loadReadingProgressForLesson, saveReadingProgressForLesson } from './js/progress.js';

import { initSettings, addStats } from './js/settings.js';
// ── Debug Logging (console only) ──────────────────────────────────────────
function logDebug(msg, type = 'info') {
  if (type === 'error') console.error(`[Lexora] ${msg}`);
  else if (type === 'warn') console.warn(`[Lexora] ${msg}`);
  else console.debug(`[Lexora] ${msg}`);
}

// Init modularized parts
initUI();
initChat();
initExport();

// ═══════════════════════════════════════════════════════════════════════════
// ── Audio Engine & TTS Orchestrator ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════


const synth = window.speechSynthesis;

// NOTE: This file historically used a set of "module globals" (config/currentLesson/etc).
// Some refactors moved state into `state.js`; missing declarations cause runtime crashes.
// Keep these declarations to preserve existing control flow.
let config = state.config;
let seekerTimer = null;
let currentAudioElement = null;
let sysUtteranceDurationEst = 0;
let sysUtteranceT0 = 0;
let sysUtteranceHighlight = false;
let currentChunkText = '';
let currentChunkWords = [];
let lastHighlightedWord = -1;

let pendingAutoplayRetry = false;
function armAutoplayRetry() {
  if (pendingAutoplayRetry) return;
  pendingAutoplayRetry = true;
  statusLabel.textContent = 'Tap anywhere once to start audio (browser autoplay policy).';
}
function disarmAutoplayRetry() {
  pendingAutoplayRetry = false;
}
function tryAutoplayRetryOnce() {
  if (!pendingAutoplayRetry) return;
  disarmAutoplayRetry();
  try {
    if (currentAudioElement && typeof currentAudioElement.play === 'function') {
      const p = currentAudioElement.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    }
  } catch (_) {}
  try { playBtn?.click(); } catch (_) {}
}
document.addEventListener('pointerdown', tryAutoplayRetryOnce, { capture: true, once: false });
document.addEventListener('keydown', tryAutoplayRetryOnce, { capture: true, once: false });

function startPlayback() {
  if (!state.currentLesson) return;
  if (speaking) return;

  speaking = true;
  isPaused = false;
  playBtn.textContent = '⏸ Pause';

  if (sentences.length === 0) {
    const plain = (state.currentLesson.content || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^[-*]\s+/gm, '');
    const maxChunk = config.ttsEngine === 'piper' ? PIPER_CHUNK_MAX_LEN : 120;
    sentences = splitIntoChunks(plain, maxChunk);
  }

  if (sentenceIdx >= sentences.length) {
    sentenceIdx = 0;
  }

  speakNext();
}

if (synth.addEventListener) {
  synth.addEventListener('voiceschanged', () => {
    if (config.ttsEngine === 'piper') populateVoicePicker([]);
  });
}
let speaking = false;
let isPaused = false;
let sentences = [], sentenceIdx = 0;
// ── State mappings for backwards compatibility in TTS ───────────────────
// Replace local TTS variables with state
const rateSlider = dom.rateSlider;
const rateLabel = dom.rateLabel;
const playBtn = dom.playBtn;
const prevBtn = dom.prevBtn;
const nextBtn = dom.nextBtn;
const voicePicker = dom.voicePicker;
const seekBar = dom.seekBar;
const statusLabel = dom.statusLabel;
const downloadProgress = dom.downloadProgress;
const downloadBar = dom.downloadBar;
const downloadText = dom.downloadText;
const kokoroDtypeRow = dom.kokoroDtypeRow;
const browserAPI = state.browserAPI;


// Piper engine — on-demand models registry
/**
 * Each entry: { label, sampleRate }
 * Models are downloaded from HuggingFace CDN on first use and cached in
 * IndexedDB by the piper-worker.  No .onnx files need to be bundled.
 */
const PIPER_MODELS = {
  amy:        { label: 'Amy (low)',                  sampleRate: 16000 },
  hfc_female: { label: 'Google Female EN (medium)',  sampleRate: 22050 },
};

/** Larger text batches per Piper inference (fewer gaps; still clause/sentence aware). */
const PIPER_CHUNK_MAX_LEN = 320;
/** Extra Piper workers for parallel prefetch (same RAM cost as Kokoro multi-worker). */
const NUM_PIPER_PREFETCH_WORKERS = 2;
const PIPER_PREFETCH_WINDOW = 28;

let piperMainWorker = null;
let piperPrefetchPool = [];
let piperReady = false;
let piperSampleRate = 16000;
let piperLoadPromise = null;
let piperLoadedModelKey = null; // tracks which model is currently loaded

const piperAudioCache = new Map(); // chunkIdx → { blob, sampleRate } | null (in-flight)
let piperSynthQueue = [];
let piperSynthCompletedCount = 0;
let piperSynthTotalCount = 0;

function createPiperWorker() {
  return new Worker(browserAPI.runtime.getURL('sidepanel/piper-worker.js'));
}

function disposePiperWorkers() {
  if (piperMainWorker) {
    try { piperMainWorker.terminate(); } catch (_) {}
    piperMainWorker = null;
  }
  for (const w of piperPrefetchPool) {
    try { w.terminate(); } catch (_) {}
  }
  piperPrefetchPool = [];
}

/**
 * Initialize a piper worker by sending it a modelKey.
 * The worker downloads (or loads from IDB cache) the model itself.
 */
function initPiperWorkerInstance(worker, modelKey) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Piper init timed out')), 300000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'initialized') {
        clearTimeout(timeout);
        resolve();
      } else if (msg.type === 'progress') {
        updateDownloadProgress(msg.progress);
      } else if (msg.type === 'log') {
        logDebug(`Piper: ${msg.message}`);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(msg.error));
      }
    };
    worker.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
    worker.postMessage({ type: 'init', modelKey });
  });
}

function piperAudioCacheHasBlob(idx) {
  const e = piperAudioCache.get(idx);
  return !!(e && e.blob);
}

async function loadPiperModel(modelKey = 'amy') {
  if (piperReady && piperLoadedModelKey === modelKey) return true;

  if (piperReady || piperLoadPromise) {
    disposePiperWorkers();
    piperReady = false;
    piperLoadPromise = null;
    piperLoadedModelKey = null;
  }

  const modelMeta = PIPER_MODELS[modelKey] || PIPER_MODELS.amy;
  piperSampleRate = modelMeta.sampleRate;

  piperLoadPromise = (async () => {
    statusLabel.textContent = `🧠 Loading Piper (${modelMeta.label})…`;
    showDownloadProgress(true);
    logDebug(`Loading Piper on-demand (${modelMeta.label}, 1 main + ${NUM_PIPER_PREFETCH_WORKERS} prefetch)…`);
    try {
      // 1) Init main worker — it downloads the model (or loads from IDB cache)
      piperMainWorker = createPiperWorker();
      await initPiperWorkerInstance(piperMainWorker, modelKey);

      // 2) Spin up prefetch pool — each reuses browser-cached IDB model (no re-download)
      piperPrefetchPool = [];
      const prefetchWorkers = [];
      for (let i = 0; i < NUM_PIPER_PREFETCH_WORKERS; i++) prefetchWorkers.push(createPiperWorker());
      await Promise.all(prefetchWorkers.map((w) => initPiperWorkerInstance(w, modelKey)));
      piperPrefetchPool = prefetchWorkers;

      const attach = (w) => {
        w.onmessage = handlePiperWorkerMessage;
      };
      attach(piperMainWorker);
      for (const w of piperPrefetchPool) attach(w);

      piperReady = true;
      piperLoadedModelKey = modelKey;
      statusLabel.textContent = '';
      showDownloadProgress(false);
      return true;
    } catch (e) {
      logDebug(`Piper load error: ${e.message}`, 'error');
      statusLabel.textContent = '❌ ' + e.message;
      showDownloadProgress(false);
      disposePiperWorkers();
      piperLoadPromise = null;
      piperLoadedModelKey = null;
      return false;
    }
  })();

  return piperLoadPromise;
}

function dispatchNextPiperWorker(worker) {
  while (piperSynthQueue.length) {
    const idx = piperSynthQueue.shift();
    const existing = piperAudioCache.get(idx);
    if (existing && existing.blob) continue;
    if (existing === null) piperAudioCache.delete(idx);
    piperAudioCache.set(idx, null);
    worker.postMessage({
      type: 'synthesize',
      text: sentences[idx].trim(),
      requestId: currentSynthesisId,
      prefetchIdx: idx,
    });
    return;
  }
}

function synthesizeAllPiper(fromIdx = 0) {
  if (!piperReady || !piperMainWorker) return;
  piperSynthQueue = [];
  piperSynthCompletedCount = 0;

  const capIdx = Math.min(fromIdx + PIPER_PREFETCH_WINDOW, sentences.length);
  const priority = [];
  for (let i = fromIdx; i < capIdx; i++) {
    const entry = piperAudioCache.get(i);
    if (entry && entry.blob) {
      piperSynthCompletedCount++;
      continue;
    }
    if (entry === null) piperAudioCache.delete(i);
    if (i === sentenceIdx) {
      priority.unshift(i);
    } else {
      priority.push(i);
    }
  }
  piperSynthQueue = priority;
  piperSynthTotalCount = piperSynthCompletedCount + piperSynthQueue.length;

  const allWorkers = [piperMainWorker, ...piperPrefetchPool];
  for (const w of allWorkers) {
    dispatchNextPiperWorker(w);
  }
}

function handlePiperWorkerMessage(e) {
  const msg = e.data;
  if (msg.requestId != null && msg.requestId !== currentSynthesisId) return;

  if (msg.type === 'audio') {
    const audioSamples = msg.data instanceof Float32Array ? msg.data : new Float32Array(msg.data || []);
    if (audioSamples.length === 0) return;
    const blob = encodeWAV(audioSamples, piperSampleRate);

    if (msg.prefetchIdx != null) {
      piperAudioCache.set(msg.prefetchIdx, { blob, sampleRate: piperSampleRate });
      piperSynthCompletedCount++;
      if (piperSynthCompletedCount < piperSynthTotalCount) {
        statusLabel.textContent = `Synthesizing ${piperSynthCompletedCount}/${piperSynthTotalCount}…`;
      } else {
        statusLabel.textContent = '';
      }
      dispatchNextPiperWorker(e.target);

      if (msg.prefetchIdx === sentenceIdx && speaking && !currentAudioElement) {
        playFromBlob(blob, piperSampleRate, 'piper');
      } else if (speaking && !currentAudioElement && piperAudioCacheHasBlob(sentenceIdx)) {
        const c = piperAudioCache.get(sentenceIdx);
        playFromBlob(c.blob, c.sampleRate, 'piper');
      }
    } else {
      statusLabel.textContent = '';
      playFromBlob(blob, piperSampleRate, 'piper');
    }
  } else if (msg.type === 'error') {
    if (msg.prefetchIdx != null) {
      piperAudioCache.delete(msg.prefetchIdx);
      dispatchNextPiperWorker(e.target);
      if (speaking) synthesizeAllPiper(sentenceIdx);
    } else {
      logDebug(`Piper synthesis error: ${msg.error}`, 'error');
      statusLabel.textContent = '';
      if (speaking && msg.requestId === currentSynthesisId) {
        advanceSentence();
        speakNext();
      }
    }
  } else if (msg.type === 'log') {
    logDebug(`Piper: ${msg.message}`);
  }
}

let kokoroWorker = null;       // main worker — synthesizes the current chunk
let prefetchPool = [];         // pool of workers for parallel prefetch
let kokoroReady = false;
let kokoroVoices = [];
/** Tracks which variant is loaded so we can reload after switching Q8 ↔ Q4. */
let kokoroLoadedDtype = null;
/** Bumped when workers are torn down so in-flight load promises ignore stale completions. */
let kokoroLoadGeneration = 0;
let currentSynthesisId = 0;

/** Parallel synth workers beyond the main worker. More = lower gaps between chunks, higher RAM (each holds an ONNX session). */
const NUM_PREFETCH_WORKERS = 2;
const audioCache = new Map(); // chunkIdx → { blob, sampleRate } | null (in-flight)
let synthQueue = [];           // indices waiting to be dispatched
let synthCompletedCount = 0;   // for progress display
let synthTotalCount = 0;       // total sentences being synthesized this run

function audioCacheHasBlob(idx) {
  const e = audioCache.get(idx);
  return !!(e && e.blob);
}

rateSlider.addEventListener('input', () => {
  const val = parseFloat(rateSlider.value);
  rateLabel.textContent = val.toFixed(2) + '×';
  if (currentAudioElement) {
    currentAudioElement.playbackRate = val;
  }
});

// ── Smooth Seeker Updates ──────────────────────────────────────────────────
let seekBarDragging = false;

seekBar.addEventListener('pointerdown', () => { seekBarDragging = true; });
window.addEventListener('pointerup', () => { seekBarDragging = false; });

function startSeekerTimer() {
  stopSeekerTimer();
  seekerTimer = setInterval(updateSeekBar, 100);
}
function stopSeekerTimer() {
  if (seekerTimer) clearInterval(seekerTimer);
  seekerTimer = null;
}
function updateSeekBar() {
  if (!sentences.length) return;

  let itemProgress = 0;
  if (currentAudioElement) {
    const rawDur = currentAudioElement.duration;
    const fallbackDur = currentAudioElement._lexoraDur;
    const dur =
      rawDur && isFinite(rawDur) && rawDur > 0 ? rawDur : fallbackDur && fallbackDur > 0 ? fallbackDur : 0;
    if (dur > 0) {
      const t = currentAudioElement.currentTime;
      itemProgress = (t && isFinite(t) ? t : 0) / dur;
    }
  } else if (sysUtteranceHighlight && sysUtteranceDurationEst > 0) {
    const elapsed = (performance.now() - sysUtteranceT0) / 1000;
    itemProgress = Math.min(1, elapsed / sysUtteranceDurationEst);
  } else {
    return;
  }

  const total = sentences.length;
  const progress = ((sentenceIdx + itemProgress) / total) * 100;

  if (!seekBarDragging) {
    seekBar.value = progress;
  }
  
  // Periodically save progress while playing
  saveReadingProgress();

  // Word-level highlight — weighted by character count for natural pacing
  const durForWords =
    currentAudioElement &&
    currentAudioElement.duration &&
    isFinite(currentAudioElement.duration) &&
    currentAudioElement.duration > 0
      ? currentAudioElement.duration
      : currentAudioElement && currentAudioElement._lexoraDur
        ? currentAudioElement._lexoraDur
        : sysUtteranceHighlight
          ? sysUtteranceDurationEst
          : 0;
  if (currentChunkWords.length && durForWords > 0) {
    let totalChars = 0;
    const charPositions = [];
    for (const w of currentChunkWords) {
      charPositions.push(totalChars);
      totalChars += w.length;
    }
    const charProgress = Math.min(1, itemProgress) * totalChars;
    let wordIdx = 0;
    for (let i = 0; i < charPositions.length; i++) {
      if (charPositions[i] <= charProgress) wordIdx = i;
    }
    wordIdx = Math.min(wordIdx, currentChunkWords.length - 1);

    if (wordIdx !== lastHighlightedWord) {
      lastHighlightedWord = wordIdx;
      browserAPI.runtime.sendMessage({
        action: 'highlightWord',
        chunkText: currentChunkText,
        wordIndex: wordIdx,
      }).catch(() => {});
    }
  }
}

// ── Voice Discovery ────────────────────────────────────────────────────────

const KOKORO_VOICE_META = {
  af_heart:    { label: 'Heart',    gender: 'F', accent: 'US', grade: 'A'  },
  af_alloy:    { label: 'Alloy',    gender: 'F', accent: 'US', grade: 'C'  },
  af_aoede:    { label: 'Aoede',    gender: 'F', accent: 'US', grade: 'C+' },
  af_bella:    { label: 'Bella',    gender: 'F', accent: 'US', grade: 'A-' },
  af_jessica:  { label: 'Jessica',  gender: 'F', accent: 'US', grade: 'D'  },
  af_kore:     { label: 'Kore',     gender: 'F', accent: 'US', grade: 'C+' },
  af_nicole:   { label: 'Nicole',   gender: 'F', accent: 'US', grade: 'B-' },
  af_nova:     { label: 'Nova',     gender: 'F', accent: 'US', grade: 'C'  },
  af_river:    { label: 'River',    gender: 'F', accent: 'US', grade: 'D'  },
  af_sarah:    { label: 'Sarah',    gender: 'F', accent: 'US', grade: 'C+' },
  af_sky:      { label: 'Sky',      gender: 'F', accent: 'US', grade: 'C-' },
  am_adam:     { label: 'Adam',     gender: 'M', accent: 'US', grade: 'F+' },
  am_echo:     { label: 'Echo',     gender: 'M', accent: 'US', grade: 'D'  },
  am_eric:     { label: 'Eric',     gender: 'M', accent: 'US', grade: 'D'  },
  am_fenrir:   { label: 'Fenrir',   gender: 'M', accent: 'US', grade: 'C+' },
  am_liam:     { label: 'Liam',     gender: 'M', accent: 'US', grade: 'D'  },
  am_michael:  { label: 'Michael',  gender: 'M', accent: 'US', grade: 'C+' },
  am_onyx:     { label: 'Onyx',     gender: 'M', accent: 'US', grade: 'D'  },
  am_puck:     { label: 'Puck',     gender: 'M', accent: 'US', grade: 'C+' },
  am_santa:    { label: 'Santa',    gender: 'M', accent: 'US', grade: 'D-' },
  bf_alice:    { label: 'Alice',    gender: 'F', accent: 'UK', grade: 'D'  },
  bf_emma:     { label: 'Emma',     gender: 'F', accent: 'UK', grade: 'B-' },
  bf_isabella: { label: 'Isabella', gender: 'F', accent: 'UK', grade: 'C'  },
  bf_lily:     { label: 'Lily',     gender: 'F', accent: 'UK', grade: 'D'  },
  bm_daniel:   { label: 'Daniel',   gender: 'M', accent: 'UK', grade: 'D'  },
  bm_fable:    { label: 'Fable',    gender: 'M', accent: 'UK', grade: 'C'  },
  bm_george:   { label: 'George',   gender: 'M', accent: 'UK', grade: 'C'  },
  bm_lewis:    { label: 'Lewis',    gender: 'M', accent: 'UK', grade: 'D+' },
};

/**
 * macOS "novelty" / comic voices (Albert, Zarvox, …) — not normal narration.
 * Matches first‑party app behavior: show real assistant voices first.
 */
function isLikelyNoveltyOrEffectVoice(v) {
  const n = v.name.trim().toLowerCase();
  const uri = (v.voiceURI || '').toLowerCase();
  const comic = [
    'albert',
    'bad news',
    'bahh',
    'bells',
    'boing',
    'bubbles',
    'cellos',
    'good news',
    'hysterical',
    'junior',
    'kathy',
    'pipe organ',
    'trinoids',
    'whisper',
    'zarvox',
    'deranged',
    'superstar',
    'phonetic',
    'shelley',
    'grandma',
    'grandpa',
    'reed (english',
    'rocko',
    'sandy',
  ];
  for (const s of comic) {
    if (n === s || n.includes(s)) return true;
  }
  if (/\b(junior|kathy)\b/.test(n) && !/siri|google|microsoft|samantha|daniel|karen/i.test(n)) return true;
  if (/emoji|chipmunk|monster|announcer|broadcast|novelty|demo voice/i.test(n + uri)) return true;
  return false;
}

/** Labels like "Google Female EN" / "Google UK English Female" on Mac Chrome */
function findGoogleFemaleEnVoice() {
  const all = synth.getVoices();
  const compact = (s) => s.replace(/\s+/g, ' ').trim();
  return (
    all.find((v) => /google\s*female\s*en\b/i.test(compact(v.name))) ||
    all.find((v) => /google.*female.*\ben\b/i.test(compact(v.name))) ||
    null
  );
}

/** e.g. Chrome's "Google UK English Female" / "Google US English Female" */
function findGoogleFemaleEnglishVoice() {
  const all = synth.getVoices();
  const gfEn = findGoogleFemaleEnVoice();
  if (gfEn) return gfEn;
  const isGoogle = (v) => /google|com\.google|googletts/i.test(v.name + (v.voiceURI || ''));
  const isFemale = (v) => /female/i.test(v.name);
  const isEn = (v) =>
    /^en/i.test(v.lang || '') ||
    /\benglish\b/i.test(v.name) ||
    /\bEN\b/.test(v.name);
  return (
    all.find((v) => isGoogle(v) && isFemale(v) && isEn(v)) ||
    all.find((v) => isGoogle(v) && isFemale(v)) ||
    null
  );
}

function findGoogleVoice() {
  const all = synth.getVoices();
  return (
    findGoogleFemaleEnVoice() ||
    findGoogleFemaleEnglishVoice() ||
    all.find((v) => v.name.includes('Siri') && v.name.includes('4')) ||
    all.find((v) => v.name.includes('Natural')) ||
    all.find((v) => v.name === 'Google US English') ||
    all.find((v) => /google/i.test(v.name)) ||
    all.find((v) => v.name.includes('Premium') && v.lang.startsWith('en')) ||
    all.find((v) => v.name.includes('Enhanced') && v.lang.startsWith('en')) ||
    all.find((v) => v.lang.startsWith('en-US')) ||
    all.find((v) => v.lang.startsWith('en')) ||
    all[0] ||
    null
  );
}

const PIPER_BUNDLED_PREFIX = 'piper|'; // e.g. 'piper|amy', 'piper|hfc_female'
const GOOGLE_VOICE_PREFIX  = 'sys|';

/**
 * Parse a voice-picker value when the Piper engine is active.
 * Returns one of:
 *   { kind: 'piper', modelKey: string }  — use the bundled ONNX model
 *   { kind: 'system', voice: SpeechSynthesisVoice | null }  — use Web Speech API
 */
function parsePiperOrSystemVoice(value) {
  if (value.startsWith(PIPER_BUNDLED_PREFIX)) {
    const modelKey = value.slice(PIPER_BUNDLED_PREFIX.length) || 'amy';
    return { kind: 'piper', modelKey };
  }
  if (value.startsWith(GOOGLE_VOICE_PREFIX)) {
    try {
      const uri = decodeURIComponent(value.slice(GOOGLE_VOICE_PREFIX.length));
      const all = synth.getVoices();
      let v = all.find((x) => x.voiceURI === uri);
      if (!v) v = all.find((x) => x.name === uri);
      return v ? { kind: 'system', voice: v } : { kind: 'system', voice: null };
    } catch (_) {
      return { kind: 'system', voice: null };
    }
  }
  // Legacy values ('piper:amy' etc.) — treat as bundled Amy
  if (value.startsWith('piper:')) return { kind: 'piper', modelKey: 'amy' };
  return { kind: 'piper', modelKey: 'amy' };
}

/** Chrome often returns 0 voices until this runs + voiceschanged. */
function primeSpeechSynthesisVoices() {
  let list = synth.getVoices();
  if (list.length > 0) return list;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    synth.cancel();
  } catch (_) {}
  return synth.getVoices();
}

function populateVoicePicker(availableVoiceIds) {
  voicePicker.innerHTML = '';

  if (config.ttsEngine === 'piper') {
    // Show on-demand downloadable Piper voices
    const piperGroup = document.createElement('optgroup');
    piperGroup.label = 'Piper (offline — downloads on first use)';

    const amy = document.createElement('option');
    amy.value = `${PIPER_BUNDLED_PREFIX}amy`;
    amy.textContent = 'Amy — Low';
    piperGroup.appendChild(amy);

    const hfcFemale = document.createElement('option');
    hfcFemale.value = `${PIPER_BUNDLED_PREFIX}hfc_female`;
    hfcFemale.textContent = '⭐ Google Female EN — Medium';
    piperGroup.appendChild(hfcFemale);

    voicePicker.appendChild(piperGroup);

    // Default to Google Female EN
    hfcFemale.selected = true;

    const systemVoices = synth.getVoices()
      .filter((v) => /^en/i.test(v.lang || '') && !isLikelyNoveltyOrEffectVoice(v))
      .slice(0, 6);
    const preferredSystemVoice = findGoogleVoice();
    const uniqueSystemVoices = [];
    for (const v of [preferredSystemVoice, ...systemVoices]) {
      if (!v) continue;
      if (uniqueSystemVoices.some((x) => x.voiceURI === v.voiceURI)) continue;
      uniqueSystemVoices.push(v);
    }
    if (uniqueSystemVoices.length) {
      const systemGroup = document.createElement('optgroup');
      systemGroup.label = 'System fallback';
      for (const v of uniqueSystemVoices) {
        const opt = document.createElement('option');
        opt.value = `${GOOGLE_VOICE_PREFIX}${encodeURIComponent(v.voiceURI || v.name)}`;
        opt.textContent = `${v.name}${v.lang ? ` (${v.lang})` : ''}`;
        systemGroup.appendChild(opt);
      }
      voicePicker.appendChild(systemGroup);
    }
    return;
  }

  // Group 1: Kokoro voices by category

  const groups = {
    '🇺🇸 American Female':  [],
    '🇺🇸 American Male':    [],
    '🇬🇧 British Female':   [],
    '🇬🇧 British Male':     [],
  };

  const voiceIds = availableVoiceIds || Object.keys(KOKORO_VOICE_META);
  for (const id of voiceIds) {
    const meta = KOKORO_VOICE_META[id];
    if (!meta) continue;
    const key = (meta.accent === 'UK' ? '🇬🇧 British' : '🇺🇸 American')
              + (meta.gender === 'F' ? ' Female' : ' Male');
    if (groups[key]) groups[key].push({ id, ...meta });
  }

  for (const [groupLabel, voices] of Object.entries(groups)) {
    if (!voices.length) continue;
    const optGroup = document.createElement('optgroup');
    optGroup.label = groupLabel;
    voices.sort((a, b) => a.label.localeCompare(b.label));
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = `kokoro:${v.id}`;
      opt.textContent = `${v.label} (${v.grade})`;
      optGroup.appendChild(opt);
    }
    voicePicker.appendChild(optGroup);
  }

  // Default to af_heart (the best voice)
  const heartOpt = voicePicker.querySelector('option[value="kokoro:af_heart"]');
  if (heartOpt) heartOpt.selected = true;
}

async function initVoice(tries = 0) {
  if (config.ttsEngine === 'piper') {
    primeSpeechSynthesisVoices();
    if (synth.getVoices().length > 0 || tries >= 40) {
      populateVoicePicker([]);
    } else {
      setTimeout(() => initVoice(tries + 1), 250);
    }
    return;
  }

  const all = synth.getVoices();
  if (all.length > 0 || tries >= 40) {
    populateVoicePicker(Object.keys(KOKORO_VOICE_META));
  } else {
    setTimeout(() => initVoice(tries + 1), 250);
  }
}

// ── Kokoro Model Loading ──────────────────────────────────────────────────

function showDownloadProgress(show) {
  if (downloadProgress) {
    downloadProgress.style.display = show ? 'block' : 'none';
  }
}

function updateDownloadProgress(progress) {
  if (!progress || !downloadBar) return;

  if (progress.status === 'progress' && progress.total) {
    const pct = Math.round((progress.loaded / progress.total) * 100);
    downloadBar.style.width = pct + '%';
    const mb = (progress.loaded / 1024 / 1024).toFixed(1);
    const totalMb = (progress.total / 1024 / 1024).toFixed(1);
    if (downloadText) downloadText.textContent = `Downloading model… ${mb}/${totalMb} MB (${pct}%)`;
  } else if (progress.status === 'ready') {
    downloadBar.style.width = '100%';
    if (downloadText) downloadText.textContent = 'Model ready!';
    setTimeout(() => showDownloadProgress(false), 1500);
  } else if (progress.status === 'initiate') {
    const name = progress.file || progress.name || '';
    if (downloadText) downloadText.textContent = `Loading ${name}…`;
  }
}

function createKokoroWorker() {
  return new Worker(
    browserAPI.runtime.getURL('sidepanel/kokoro-worker.js'),
    { type: 'module' }
  );
}

function initWorker(worker, label, dtype = 'q8') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 300000);

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        updateDownloadProgress(msg.progress);
      } else if (msg.type === 'initialized') {
        clearTimeout(timeout);
        logDebug(`${label} ready. ${(msg.voices || []).length} voices.`);
        resolve(msg.voices || []);
      } else if (msg.type === 'log') {
        logDebug(`${label}: ${msg.message}`);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(msg.error));
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };

    // q8 → smaller download; q4 → larger HF cache, typically faster WASM inference (your ~6s startup).
    worker.postMessage({ type: 'init', dtype, device: 'wasm' });
  });
}

let kokoroLoadPromise = null;

function disposeKokoroWorkers() {
  kokoroLoadGeneration++;
  cancelAudio(true);
  if (kokoroWorker) {
    try { kokoroWorker.terminate(); } catch (_) {}
    kokoroWorker = null;
  }
  for (const w of prefetchPool) {
    try { w.terminate(); } catch (_) {}
  }
  prefetchPool = [];
  kokoroReady = false;
  kokoroVoices = [];
  kokoroLoadedDtype = null;
  kokoroLoadPromise = null;
}

function updateKokoroDtypeRowVisibility() {
  if (!kokoroDtypeRow) return;
  kokoroDtypeRow.style.display = config.ttsEngine === 'kokoro' ? 'block' : 'none';
}

function resolveKokoroDtype() {
  return config.kokoroDtype === 'q4' ? 'q4' : 'q8';
}

async function loadKokoroModel() {
  const wantDtype = resolveKokoroDtype();
  if (kokoroReady && kokoroLoadedDtype === wantDtype) return true;
  if (kokoroLoadPromise) return kokoroLoadPromise;

  if (kokoroWorker || prefetchPool.length || (kokoroReady && kokoroLoadedDtype !== wantDtype)) {
    disposeKokoroWorkers();
  }

  kokoroLoadPromise = (async () => {
    const loadSnapshot = kokoroLoadGeneration;
    const dtype = resolveKokoroDtype();
    statusLabel.textContent = '🧠 Loading Kokoro Neural Engine…';
    showDownloadProgress(true);
    logDebug(`Loading Kokoro (${dtype}, 1 main + ${NUM_PREFETCH_WORKERS} prefetch workers)…`);

    try {
      // 1) Init main worker first — downloads & caches the model variant
      kokoroWorker = createKokoroWorker();
      const voices = await initWorker(kokoroWorker, 'Main', dtype);
      if (loadSnapshot !== kokoroLoadGeneration) return false;
      kokoroWorker.onmessage = handleKokoroWorkerMessage;

      // 2) Spin up prefetch pool in parallel — each reuses browser-cached model weights (no serial wait)
      prefetchPool = [];
      const prefetchWorkers = Array.from({ length: NUM_PREFETCH_WORKERS }, () => createKokoroWorker());
      await Promise.all(prefetchWorkers.map((w, i) => initWorker(w, `Pool-${i}`, dtype)));
      if (loadSnapshot !== kokoroLoadGeneration) return false;
      for (const w of prefetchWorkers) {
        w.onmessage = handleKokoroWorkerMessage;
        prefetchPool.push(w);
      }

      if (loadSnapshot !== kokoroLoadGeneration) return false;
      kokoroReady = true;
      kokoroLoadedDtype = dtype;
      kokoroVoices = voices;
      statusLabel.textContent = '';
      showDownloadProgress(false);
      if (kokoroVoices.length) populateVoicePicker(kokoroVoices);

      return true;
    } catch (e) {
      if (loadSnapshot === kokoroLoadGeneration) {
        logDebug(`Kokoro load error: ${e.message}`, 'error');
        statusLabel.textContent = '❌ ' + e.message;
        showDownloadProgress(false);
        if (kokoroWorker) {
          try { kokoroWorker.terminate(); } catch (_) {}
          kokoroWorker = null;
        }
        for (const w of prefetchPool) {
          try { w.terminate(); } catch (_) {}
        }
        prefetchPool = [];
        kokoroReady = false;
        kokoroLoadedDtype = null;
      }
      kokoroLoadPromise = null;
      return false;
    }
  })();

  return kokoroLoadPromise;
}

// ── Audio Control ─────────────────────────────────────────────────────────

function cancelAudio(clearCache = false) {
  currentSynthesisId++;
  sysUtteranceHighlight = false;
  if (kokoroWorker) {
    try { kokoroWorker.postMessage({ type: 'cancel' }); } catch (_) {}
  }
  for (const w of prefetchPool) {
    try { w.postMessage({ type: 'cancel' }); } catch (_) {}
  }
  synthQueue = [];
  stopSeekerTimer();
  sendClearHighlight(true);
  if (currentAudioElement) {
    try {
      if (typeof currentAudioElement.pause === 'function') currentAudioElement.pause();
      if (currentAudioElement.src) URL.revokeObjectURL(currentAudioElement.src);
    } catch(_) {}
    currentAudioElement = null;
  }
  synth.cancel();
  if (clearCache) {
    audioCache.forEach(v => { if (v && v.url) URL.revokeObjectURL(v.url); });
    audioCache.clear();
    synthCompletedCount = 0;
    synthTotalCount = 0;
    piperAudioCache.clear();
    piperSynthQueue = [];
    piperSynthCompletedCount = 0;
    piperSynthTotalCount = 0;
  } else {
    // Drop in-flight placeholders from a cancelled run — otherwise synthesizeAll / dispatch skip those indices forever.
    for (const [k, v] of audioCache) {
      if (v == null) audioCache.delete(k);
    }
    for (const [k, v] of piperAudioCache) {
      if (v == null) piperAudioCache.delete(k);
    }
  }
}



function sendClearHighlight(fullReset = false) {
  currentChunkWords = [];
  currentChunkText = '';
  lastHighlightedWord = -1;
  browserAPI.runtime.sendMessage({ action: 'clearHighlight', fullReset }).catch(() => {});
}

function dispatchNextToWorker(worker, voiceId) {
  while (synthQueue.length) {
    const idx = synthQueue.shift();
    const existing = audioCache.get(idx);
    if (existing && existing.blob) continue;
    if (existing === null) audioCache.delete(idx);
    audioCache.set(idx, null);
    worker.postMessage({
      type: 'prefetch',
      text: sentences[idx].trim(),
      voice: voiceId,
      requestId: currentSynthesisId,
      prefetchIdx: idx,
    });
    return;
  }
}

const PREFETCH_WINDOW = 20;

function synthesizeAll(voiceId, fromIdx = 0) {
  if (!kokoroReady) return;
  synthQueue = [];

  synthCompletedCount = 0;

  const capIdx = Math.min(fromIdx + PREFETCH_WINDOW, sentences.length);
  const priority = [];
  for (let i = fromIdx; i < capIdx; i++) {
    const entry = audioCache.get(i);
    if (entry && entry.blob) {
      synthCompletedCount++;
      continue;
    }
    if (entry === null) audioCache.delete(i);
    if (i === sentenceIdx) {
      priority.unshift(i);
    } else {
      priority.push(i);
    }
  }
  synthQueue = priority;
  synthTotalCount = synthCompletedCount + synthQueue.length;

  const allWorkers = [kokoroWorker, ...prefetchPool];
  for (const w of allWorkers) {
    dispatchNextToWorker(w, voiceId);
  }
}

function playFromBlob(blob, sampleRate, _voiceId) {
  sysUtteranceHighlight = false;
  const url = URL.createObjectURL(blob);
  currentAudioElement = new Audio(url);
  currentAudioElement.playbackRate = parseFloat(rateSlider.value);
  try { currentAudioElement.preservesPitch = true; } catch (_) {}
  try { currentAudioElement.muted = false; currentAudioElement.volume = 1; } catch (_) {}
  const pcmBytes = Math.max(0, blob.size - 44);
  currentAudioElement._lexoraDur = pcmBytes / (sampleRate * 2);

  // Set up word tracking for the current chunk
  const text = sentences[sentenceIdx] || '';
  currentChunkText = text.trim();
  currentChunkWords = currentChunkText.split(/\s+/).filter(Boolean);
  lastHighlightedWord = -1;
  const chunkWordCount = currentChunkWords.length || 1;

  currentAudioElement.addEventListener(
    'durationchange',
    () => {
      const d = currentAudioElement.duration;
      if (d && isFinite(d) && d > 0) currentAudioElement._lexoraDur = d;
    },
    { once: true }
  );

  currentAudioElement.onended = () => {
    // Capture metrics BEFORE we clear refs.
    const durSec = currentAudioElement?._lexoraDur || currentAudioElement?.duration || 0;
    const durMs = isFinite(durSec) && durSec > 0 ? durSec * 1000 : 0;

    URL.revokeObjectURL(url);
    sendClearHighlight();
    if (speaking) {
      advanceSentence(chunkWordCount, durMs);
      currentAudioElement = null;
      speakNext();
    } else {
      currentAudioElement = null;
      stopSeekerTimer();
    }
  };

  if (speaking) {
    const p = currentAudioElement.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        logDebug(`Audio play blocked: ${err?.message || err}`, 'error');
        armAutoplayRetry();
      });
    }
    startSeekerTimer();
  }
}

function handleKokoroWorkerMessage(e) {
  const msg = e.data;

  // Ignore stale messages from a cancelled session
  if (msg.requestId != null && msg.requestId !== currentSynthesisId) return;

  if (msg.type === 'audio') {
    const sampleRate = msg.sampleRate || 24000;
    const audioSamples = msg.audio instanceof Float32Array
      ? msg.audio
      : new Float32Array(msg.audio || []);

    if (audioSamples.length === 0) return;

    const blob = encodeWAV(audioSamples, sampleRate);
    const voiceId = voicePicker.value.split(':')[1];

    if (msg.prefetchIdx != null) {
      audioCache.set(msg.prefetchIdx, { blob, sampleRate });
      synthCompletedCount++;
      logDebug(`Synthesized ${synthCompletedCount}/${synthTotalCount}`);

      if (synthCompletedCount < synthTotalCount) {
        statusLabel.textContent = `Synthesizing ${synthCompletedCount}/${synthTotalCount}…`;
      } else {
        statusLabel.textContent = '';
      }

      // Feed this worker the next queued chunk
      dispatchNextToWorker(e.target, voiceId);

      // If we're waiting for this exact sentence, play it now
      if (msg.prefetchIdx === sentenceIdx && speaking && !currentAudioElement) {
        playFromBlob(blob, sampleRate, voiceId);
      } else if (speaking && !currentAudioElement && audioCacheHasBlob(sentenceIdx)) {
        const c = audioCache.get(sentenceIdx);
        playFromBlob(c.blob, c.sampleRate, voiceId);
      }
    } else {
      statusLabel.textContent = '';
      playFromBlob(blob, sampleRate, voiceId);
    }
  } else if (msg.type === 'discarded') {
    if (msg.prefetchIdx != null) audioCache.delete(msg.prefetchIdx);
    const sel = voicePicker.value;
    if (!sel.startsWith('kokoro:')) return;
    const voiceId = sel.split(':')[1];
    dispatchNextToWorker(e.target, voiceId);
    if (speaking) synthesizeAll(voiceId, sentenceIdx);
  } else if (msg.type === 'error') {
    const voiceId = voicePicker.value.split(':')[1];
    if (msg.prefetchIdx != null) {
      audioCache.delete(msg.prefetchIdx);
      dispatchNextToWorker(e.target, voiceId);
    } else {
      logDebug(`Synthesis error: ${msg.error}`, 'error');
      statusLabel.textContent = '';
      if (speaking) { advanceSentence(); speakNext(); }
    }
  } else if (msg.type === 'log') {
    logDebug(`Worker: ${msg.message}`);
  } else if (msg.type === 'progress') {
    updateDownloadProgress(msg.progress);
  }
}

let needsResynthOnResume = false;

voicePicker.addEventListener('change', () => {
  const wasSpeaking = speaking;
  const wasPaused = isPaused;
  cancelAudio(true);

  if (wasSpeaking) {
    speaking = true;
    isPaused = false;
    playBtn.textContent = '⏸ Pause';
    speakNext();
  } else if (wasPaused) {
    needsResynthOnResume = true;
  }
});

let seekDebounce = null;
seekBar.addEventListener('input', () => {
  if (sentences.length === 0) return;
  
  const pct = parseFloat(seekBar.value);
  const floatIdx = (pct / 100) * sentences.length;
  const newIdx = Math.floor(floatIdx);
  
  if (newIdx === sentenceIdx && currentAudioElement && !isPaused) {
    if (currentAudioElement.duration) {
      const subProgress = floatIdx - newIdx;
      currentAudioElement.currentTime = subProgress * currentAudioElement.duration;
      return;
    }
  }

  if (seekDebounce) clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    cancelAudio(false);
    sentenceIdx = Math.min(sentences.length - 1, newIdx);
    isPaused = false;
    speaking = true;
    playBtn.textContent = '⏸ Pause';
    speakNext();
  }, 80);
});

prevBtn.addEventListener('click', () => {
  if (sentences.length === 0) return;
  cancelAudio();
  sentenceIdx = Math.max(0, sentenceIdx - 1);
  if (speaking) {
    isPaused = false;
    speakNext();
  }
});

nextBtn.addEventListener('click', () => {
  if (sentences.length === 0) return;
  cancelAudio();
  sentenceIdx = Math.min(sentences.length - 1, sentenceIdx + 1);
  if (speaking) {
    isPaused = false;
    speakNext();
  }
});

playBtn.addEventListener('click', async () => {
  if (!state.currentLesson) return;

  // Ignore duplicate triggers while loading a model (auto-play can fire twice: message + init).
  if (playBtn.disabled || /⏳\s*Loading/i.test(playBtn.textContent || '')) return;

  if (speaking) {
    if (currentAudioElement && typeof currentAudioElement.pause === 'function') {
      try {
        currentAudioElement.pause();
      } catch (_) {}
    } else {
      synth.cancel();
    }
    speaking = false;
    isPaused = true;
    playBtn.textContent = '▶ Resume';
    stopSeekerTimer();
    sendClearHighlight(true);
    return;
  }

  if (isPaused) {
    isPaused = false;
    speaking = true;
    playBtn.textContent = '⏸ Pause';

    if (needsResynthOnResume) {
      needsResynthOnResume = false;
      speakNext();
      return;
    }

    if (currentAudioElement && typeof currentAudioElement.play === 'function') {
      try {
        await currentAudioElement.play();
        startSeekerTimer();
      } catch (_) {
        speakNext();
      }
      return;
    }

    speakNext();
    return;
  }

  startPlayback();
});

// ── Shared system-voice synthesis helper ─────────────────────────────────
/** Speaks `text` via Web Speech API with the given voice and rate. */
function speakWithSystemVoice(text, voice, rate) {
  currentChunkText = text;
  currentChunkWords = text.split(/\s+/).filter(Boolean);
  lastHighlightedWord = -1;
  const wordCount = currentChunkWords.length || 1;
  sysUtteranceDurationEst = Math.max(1.2, (text.length / 13 + wordCount * 0.28) / Math.max(0.35, rate));

  const utt = new SpeechSynthesisUtterance(text);
  if (voice) utt.voice = voice;
  utt.rate = rate;
  utt.onstart = () => {
    sysUtteranceHighlight = true;
    sysUtteranceT0 = performance.now();
    startSeekerTimer();
  };
  utt.onend = () => {
    sysUtteranceHighlight = false;
    advanceSentence();
    speakNext();
  };
  utt.onerror = (ev) => {
    sysUtteranceHighlight = false;
    const err = ev && ev.error;
    if (err === 'interrupted' || err === 'canceled' || err === 'cancelled') return;
    advanceSentence();
    speakNext();
  };
  synth.speak(utt);
  currentAudioElement = null;
}

async function speakNext() {
  if (!speaking || sentenceIdx >= sentences.length) {
    speaking = false;
    playBtn.textContent = '▶ Play';
    seekBar.value = 100;
    statusLabel.textContent = '';
    sendClearHighlight(true);
    return;
  }
  
  const pct = Math.round((sentenceIdx / sentences.length) * 100);
  seekBar.value = pct;
  
  const text = sentences[sentenceIdx].trim();
  const selectedValue = voicePicker.value;
  const engine = config.ttsEngine || 'kokoro';

  if (engine === 'piper') {
    const picked = parsePiperOrSystemVoice(selectedValue);
    if (picked.kind === 'system') {
      if (!picked.voice) {
        statusLabel.textContent = 'Voice missing — click ↻ Refresh voices or wait for the list to load.';
        if (speaking) {
          advanceSentence();
          speakNext();
        }
        return;
      }
      playBtn.textContent = '⏸ Pause';
      statusLabel.textContent = '';
      speakWithSystemVoice(text, picked.voice, parseFloat(rateSlider.value));
      return;
    }

    // ── Piper TTS (bundled ONNX + parallel prefetch) ─────────────────────
    playBtn.disabled = true;
    playBtn.textContent = '⏳ Loading…';
    const ok = await loadPiperModel(picked.modelKey || 'amy');
    playBtn.disabled = false;

    if (!ok || !speaking) {
      playBtn.textContent = '▶ Play';
      return;
    }
    playBtn.textContent = '⏸ Pause';

    synthesizeAllPiper(sentenceIdx);

    const cached = piperAudioCache.get(sentenceIdx);
    if (cached && cached.blob) {
      statusLabel.textContent =
        piperSynthCompletedCount < piperSynthTotalCount
          ? `Synthesizing ${piperSynthCompletedCount}/${piperSynthTotalCount}…`
          : '';
      playFromBlob(cached.blob, cached.sampleRate, picked.modelKey || 'piper');
      return;
    }

    statusLabel.textContent = `Synthesizing ${piperSynthCompletedCount}/${piperSynthTotalCount}…`;
    return;
  }

  if (engine === 'kokoro' && selectedValue.startsWith('kokoro:')) {
    // ── Kokoro TTS (with prefetch-ahead pipeline) ───────────────────────
    const voiceId = selectedValue.split(':')[1];
    playBtn.disabled = true;
    playBtn.textContent = '⏳ Loading…';
    const ok = await loadKokoroModel();
    playBtn.disabled = false;
    if (!ok || !speaking) {
      playBtn.textContent = '▶ Play';
      return;
    }
    playBtn.textContent = '⏸ Pause';

    // Synthesize from current sentence forward
    synthesizeAll(voiceId, sentenceIdx);

    // Check if this sentence was already cached
    const cached = audioCache.get(sentenceIdx);
    if (cached && cached.blob) {
      statusLabel.textContent = synthCompletedCount < synthTotalCount
        ? `Synthesizing ${synthCompletedCount}/${synthTotalCount}…` : '';
      playFromBlob(cached.blob, cached.sampleRate, voiceId);
      return;
    }

    // Not cached yet — waiting for worker to finish this chunk
    statusLabel.textContent = `Synthesizing ${synthCompletedCount}/${synthTotalCount}…`;
  } else {
    // ── Native Speech Fallback (should be rare) ─────────────────────────
    speakWithSystemVoice(text, null, parseFloat(rateSlider.value));
  }
}

initSettings();

// Export resetNarrationForNewLesson for ui.js to use
export function resetNarrationForNewLesson() {
  cancelAudio(true);
  sentences = [];
  sentenceIdx = 0;
  speaking = false;
  isPaused = false;
  needsResynthOnResume = false;
  
  if (playBtn) playBtn.textContent = '▶ Play';
  seekBar.value = 0;

  // Restore reading progress for the new lesson
  if (state.currentLesson && state.currentLesson.url && state.currentLesson.title !== 'Selected Text') {
    loadReadingProgressForLesson(browserAPI, state.currentLesson).then((v) => {
      if (v === null || v === undefined) return;
      // We defer applying it slightly because sentences[] gets populated when user clicks Play or via other logic.
      // But we can set sentenceIdx now so that playAudio() starts from there.
      sentenceIdx = v;
      if (sentences.length > 0) {
        seekBar.value = (sentenceIdx / sentences.length) * 100;
      }
    }).catch(() => {});
  }
}

// Debounce-save reading progress
let progressSaveTimeout = null;
function saveReadingProgress() {
  if (!state.currentLesson || !state.currentLesson.url) return;
  if (state.currentLesson.title === 'Selected Text') return;
  clearTimeout(progressSaveTimeout);
  progressSaveTimeout = setTimeout(() => {
    saveReadingProgressForLesson(browserAPI, state.currentLesson, sentenceIdx);
  }, 1000);
}

function advanceSentence(wordsOverride, timeMsOverride) {
  const wordsRead =
    Number.isFinite(wordsOverride) && wordsOverride > 0
      ? Math.floor(wordsOverride)
      : (currentChunkWords?.length || 1);

  let timeMs = 0;
  if (Number.isFinite(timeMsOverride) && timeMsOverride > 0) {
    timeMs = timeMsOverride;
  } else if (currentAudioElement) {
    timeMs = (currentAudioElement._lexoraDur || currentAudioElement.duration || 0) * 1000;
  } else if (sysUtteranceDurationEst) {
    timeMs = sysUtteranceDurationEst * 1000;
  }
  if (!isFinite(timeMs) || isNaN(timeMs)) timeMs = 0;

  addStats(wordsRead, timeMs);
  sentenceIdx++;
  saveReadingProgress();
}



// ── Minimized overlay: parent page forwards prev / play / next via postMessage ──
initMiniPlayerBridge({ browserAPI, playBtn, prevBtn, nextBtn });

// ── Keyboard Shortcuts ──────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName.toLowerCase();
  const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (isEditable) return; // Don't intercept when user is typing

  if (e.code === 'Space') {
    e.preventDefault();
    playBtn?.click();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    prevBtn?.click();
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    nextBtn?.click();
  }
});

// Expose audio functions for other modules
window.lexoraAudio = {
  updateKokoroDtypeRowVisibility,
  initVoice,
  cancelAudio,
  showDownloadProgress,
  disposeKokoroWorkers,
  resetNarrationForNewLesson,
  advanceSentence,
  startPlayback
};
