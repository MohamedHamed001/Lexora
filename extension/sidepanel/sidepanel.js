// sidepanel.js — Lexora Kokoro Edition
const browserAPI =
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
  (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

if (!browserAPI) {
  throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}

let currentLesson = null;
let config = {
  url: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'local-model',
  key: '',
  ttsEngine: 'kokoro',
  /** Kokoro ONNX variant: q4 = larger HF cache, usually faster WASM; q8 = smaller download. */
  kokoroDtype: 'q8',
};

// ── Debug Console ──────────────────────────────────────────────────────────
const debugConsole = document.getElementById('debug-console');
const debugLogLines = document.getElementById('debug-log-lines');

function logDebug(msg, type = 'info') {
  if (debugConsole) debugConsole.style.display = 'none';
  const line = document.createElement('div');
  line.style.marginBottom = '2px';
  line.style.color = type === 'error' ? '#f87171' : (type === 'warn' ? '#fbbf24' : '#86efac');
  line.textContent = `[${new Date().toLocaleTimeString([], {hour12:false})}] ${msg}`;
  debugLogLines.appendChild(line);
  debugLogLines.parentElement.scrollTop = debugLogLines.parentElement.scrollHeight;
  console.log(`[Lexora] ${msg}`);
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById(`${id}-panel`);
    if (panel) panel.style.display = id === 'chat' ? 'flex' : 'block';
  };
});

// ── Capture button ─────────────────────────────────────────────────────────
const captureBtn    = document.getElementById('capture-btn');
const captureStatus = document.getElementById('capture-status');
const popOutBtn     = document.getElementById('pop-out-btn');

// Refresh UI if storage updates (e.g. overlay/sidepanel sync).
browserAPI.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.currentLesson?.newValue) {
    currentLesson = changes.currentLesson.newValue;
    applyLesson(currentLesson);
  }
});

if (popOutBtn) {
  if (window.parent !== window) {
    popOutBtn.style.display = 'none';
  }

  popOutBtn.addEventListener('click', () => {
    browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { action: 'toggleOverlay' });
        window.close();
      }
    });
  });
}

captureBtn.addEventListener('click', () => {
  captureBtn.textContent   = '⏳ Scanning…';
  captureBtn.disabled      = true;
  captureStatus.textContent = '';

  browserAPI.runtime.sendMessage({ action: 'triggerDeepCapture' }, (resp) => {
    captureBtn.disabled = false;

    if (resp && resp.success) {
      currentLesson = resp.data;
      browserAPI.storage.local.set({ currentLesson });
      applyLesson(currentLesson);
      captureBtn.textContent = '✅ Captured';
      if (captureStatus) captureStatus.textContent = '';
      setTimeout(() => { captureBtn.textContent = '✨ Capture'; }, 2500);
    } else {
      captureBtn.textContent = '✨ Capture';
      captureStatus.textContent = '⚠️ ' + (resp?.error || 'No content found on this page.');
    }
  });
});

// ── Apply lesson to all tabs ───────────────────────────────────────────────
function applyLesson(lesson) {
  if (!lesson) return;

  const urlEl = document.getElementById('lesson-url');
  const titleEl = document.getElementById('lesson-title');
  const lessonHeader = document.getElementById('lesson-header');

  if (urlEl) {
    try { urlEl.textContent = new URL(lesson.url).hostname; }
    catch (_) { urlEl.textContent = lesson.url || ''; }
  }
  if (titleEl) titleEl.textContent = lesson.title || 'Unnamed';
  if (lessonHeader) lessonHeader.style.display = 'block';

  document.getElementById('lesson-text').innerHTML = mdToHtml(lesson.content || '');

  const info = document.getElementById('export-info');
  if (info) info.textContent = `📖 "${lesson.title}" — ready to export.`;

  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = `<div class="ai-bubble">✅ Captured <strong>${escHtml(lesson.title)}</strong>. Ask me anything!</div>`;
}

// ── Simple Markdown Parsing ────────────────────────────────────────────────
function mdToHtml(md) {
  const lines = (md || '').split('\n');
  let html = '', inList = false;

  lines.forEach(raw => {
    const line = raw.trimEnd();
    if (/^#{2,}\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3 class="md-h3">${inlineMd(escHtml(line.replace(/^#{2,}\s+/, '')))}</h3>`;
    } else if (/^#\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h2 class="md-h2">${inlineMd(escHtml(line.replace(/^#\s+/, '')))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul class="md-ul">'; inList = true; }
      html += `<li>${inlineMd(escHtml(line.replace(/^[-*]\s+/, '')))}</li>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div style="height:0.4em"></div>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p class="md-p">${inlineMd(escHtml(line))}</p>`;
    }
  });

  if (inList) html += '</ul>';
  return html;
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code class="md-code">$1</code>');
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── AI Chat ────────────────────────────────────────────────────────────────
document.getElementById('chat-input').addEventListener('keypress', e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const q = e.target.value.trim();
  e.target.value = '';

  addBubble('user', q);
  if (!currentLesson) { addBubble('ai', '❌ Please capture a page first!'); return; }

  const headers = { 'Content-Type': 'application/json' };
  if (config.key) headers['Authorization'] = `Bearer ${config.key}`;

  const thinking = addBubble('ai', '…');
  browserAPI.runtime.sendMessage({
    action: 'proxyFetch',
    url:    config.url,
    method: 'POST',
    headers: headers,
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: `You are a concise study assistant. Answer based on this lesson:\n\nTitle: ${currentLesson.title}\n\n${currentLesson.content}` },
        { role: 'user', content: q },
      ],
      temperature: 0.7,
    },
  }, resp => {
    if (resp?.success) {
      thinking.innerHTML = mdToHtml(resp.data.choices[0].message.content);
    } else {
      thinking.innerText = `❌ Error: ${resp?.error || 'Could not reach API.'}`;
    }
    document.getElementById('content-container').scrollTop = 99999;
  });
});

function addBubble(role, text) {
  const box = document.getElementById('chat-messages');
  const el  = document.createElement('div');
  el.className = role === 'user' ? 'user-bubble' : 'ai-bubble';
  el.innerText  = text;
  box.appendChild(el);
  document.getElementById('content-container').scrollTop = 99999;
  return el;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Kokoro Audio Engine ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const synth = window.speechSynthesis;
if (synth.addEventListener) {
  synth.addEventListener('voiceschanged', () => {
    if (config.ttsEngine === 'piper') populateVoicePicker([]);
  });
}
let speaking = false;
let isPaused = false;
let sentences = [], sentenceIdx = 0;
let googleVoice = null;

// Float32Array → WAV Blob
function encodeWAV(samples, sampleRate = 24000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeString = (off, s) => { for (let i=0; i<s.length; i++) view.setUint8(off+i, s.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Split text into short chunks for faster synthesis.
 * Targets ~80-150 chars per chunk, breaking at natural pause points.
 */
function splitIntoChunks(text, maxLen = 120) {
  if (!text || !text.trim()) return [text || ''];

  // First split into sentences
  const rawSentences = text.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) || [text];
  const chunks = [];

  for (const sent of rawSentences) {
    const trimmed = sent.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxLen) {
      chunks.push(trimmed);
      continue;
    }

    // Long sentence — split at clause boundaries
    const clauses = trimmed.split(/(?<=[,;:–—])\s+/);
    let buf = '';
    for (const clause of clauses) {
      if (buf && (buf.length + clause.length) > maxLen) {
        chunks.push(buf.trim());
        buf = clause;
      } else {
        buf = buf ? buf + ' ' + clause : clause;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  return chunks.length ? chunks : [text];
}

const rateSlider  = document.getElementById('rate-slider');
const rateLabel   = document.getElementById('rate-label');
const playBtn     = document.getElementById('play-btn');
const prevBtn     = document.getElementById('prev-btn');
const nextBtn     = document.getElementById('next-btn');
const voicePicker = document.getElementById('voice-picker');
const voiceHintEl = document.getElementById('voice-hint');
const refreshVoicesBtn = document.getElementById('refresh-voices-btn');
const seekBar     = document.getElementById('seek-bar');
const statusLabel = document.getElementById('status-label');
const downloadProgress = document.getElementById('download-progress');
const downloadBar      = document.getElementById('download-bar');
const downloadText     = document.getElementById('download-text');
const ttsEngineSelect  = document.getElementById('tts-engine');
const kokoroDtypeSelect = document.getElementById('kokoro-dtype');
const kokoroDtypeRow = document.getElementById('kokoro-dtype-row');

let currentAudioElement = null;
let seekerTimer = null;
let currentChunkWords = [];
let currentChunkText = '';
let lastHighlightedWord = -1;
/** Word highlight while using SpeechSynthesis (no HTML Audio currentTime). */
let sysUtteranceHighlight = false;
let sysUtteranceT0 = 0;
let sysUtteranceDurationEst = 0;

// Piper engine — bundled models registry
/**
 * Each entry: { file: '<basename>.onnx', label: '<display name>', sampleRate: <fallback Hz> }
 * The .onnx and .onnx.json files must both live in sidepanel/.
 */
const PIPER_MODELS = {
  amy:        { file: 'amy-low.onnx',                  label: 'Amy (low)',             sampleRate: 16000 },
  hfc_female: { file: 'en_US-hfc_female-medium.onnx',  label: 'Google Female EN (medium)', sampleRate: 22050 },
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

function initPiperWorkerInstance(worker, sourceModelBuffer, configJson) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Piper init timed out')), 300000);
    const modelCopy = sourceModelBuffer.slice(0);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'initialized') {
        clearTimeout(timeout);
        resolve();
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
    worker.postMessage({ type: 'init', model: modelCopy, config: configJson }, [modelCopy]);
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

  piperLoadPromise = (async () => {
    statusLabel.textContent = `🧠 Loading Piper (${modelMeta.label}, 1 + ${NUM_PIPER_PREFETCH_WORKERS} prefetch)…`;
    try {
      const modelUrl = browserAPI.runtime.getURL(`sidepanel/${modelMeta.file}`);
      const configUrl = browserAPI.runtime.getURL(`sidepanel/${modelMeta.file}.json`);
      const [modelResp, configResp] = await Promise.all([fetch(modelUrl), fetch(configUrl)]);
      if (!modelResp.ok || !configResp.ok) throw new Error(`Failed to load Piper model assets (${modelMeta.label})`);

      const modelBuffer = await modelResp.arrayBuffer();
      const configJson = await configResp.text();

      try {
        const parsed = JSON.parse(configJson);
        if (parsed?.audio?.sample_rate) piperSampleRate = parsed.audio.sample_rate;
        else piperSampleRate = modelMeta.sampleRate;
      } catch (_) {
        piperSampleRate = modelMeta.sampleRate;
      }

      piperMainWorker = createPiperWorker();
      await initPiperWorkerInstance(piperMainWorker, modelBuffer, configJson);

      piperPrefetchPool = [];
      const prefetchWorkers = [];
      for (let i = 0; i < NUM_PIPER_PREFETCH_WORKERS; i++) prefetchWorkers.push(createPiperWorker());
      await Promise.all(prefetchWorkers.map((w) => initPiperWorkerInstance(w, modelBuffer, configJson)));
      piperPrefetchPool = prefetchWorkers;

      const attach = (w) => {
        w.onmessage = handlePiperWorkerMessage;
      };
      attach(piperMainWorker);
      for (const w of piperPrefetchPool) attach(w);

      piperReady = true;
      piperLoadedModelKey = modelKey;
      statusLabel.textContent = '';
      return true;
    } catch (e) {
      logDebug(`Piper load error: ${e.message}`, 'error');
      statusLabel.textContent = '❌ ' + e.message;
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
        sentenceIdx++;
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
const PIPER_VOICE_PREFIX  = 'piper|amy'; // kept for back-compat checks
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
    if (voiceHintEl) voiceHintEl.style.display = 'none';

    // Only show the two bundled offline models — no Mac/system voices
    const piperGroup = document.createElement('optgroup');
    piperGroup.label = 'Piper (offline — bundled)';

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
    return;
  }

  if (voiceHintEl) voiceHintEl.style.display = 'none';

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

function playFromBlob(blob, sampleRate, voiceId) {
  sysUtteranceHighlight = false;
  const url = URL.createObjectURL(blob);
  currentAudioElement = new Audio(url);
  currentAudioElement.playbackRate = parseFloat(rateSlider.value);
  currentAudioElement.preservesPitch = true;
  const pcmBytes = Math.max(0, blob.size - 44);
  currentAudioElement._lexoraDur = pcmBytes / (sampleRate * 2);

  // Set up word tracking for the current chunk
  const text = sentences[sentenceIdx] || '';
  currentChunkText = text.trim();
  currentChunkWords = currentChunkText.split(/\s+/).filter(Boolean);
  lastHighlightedWord = -1;

  currentAudioElement.addEventListener(
    'durationchange',
    () => {
      const d = currentAudioElement.duration;
      if (d && isFinite(d) && d > 0) currentAudioElement._lexoraDur = d;
    },
    { once: true }
  );

  currentAudioElement.onended = () => {
    URL.revokeObjectURL(url);
    currentAudioElement = null;
    sendClearHighlight();
    if (speaking) {
      sentenceIdx++;
      speakNext();
    } else {
      stopSeekerTimer();
    }
  };

  if (speaking) {
    const p = currentAudioElement.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        logDebug(`Audio play blocked: ${err?.message || err}`, 'error');
        statusLabel.textContent = 'Tap Play again if audio did not start (browser autoplay policy).';
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
      if (speaking) { sentenceIdx++; speakNext(); }
    }
  } else if (msg.type === 'log') {
    logDebug(`Worker: ${msg.message}`);
  } else if (msg.type === 'progress') {
    updateDownloadProgress(msg.progress);
  }
}

let needsResynthOnResume = false;

voicePicker.addEventListener('change', () => {
  const val = voicePicker.value;
  googleVoice = null;

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
  if (!currentLesson) return;

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

  speaking = true;
  isPaused = false;
  playBtn.textContent = '⏸ Pause';
  
  if (sentences.length === 0) {
    const plain = (currentLesson.content || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^[-*]\s+/gm, '');
    const maxChunk = config.ttsEngine === 'piper' ? PIPER_CHUNK_MAX_LEN : 120;
    sentences = splitIntoChunks(plain, maxChunk);
  }
  speakNext();
});

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
          sentenceIdx++;
          speakNext();
        }
        return;
      }
      playBtn.textContent = '⏸ Pause';
      statusLabel.textContent = '';
      currentChunkText = text;
      currentChunkWords = text.split(/\s+/).filter(Boolean);
      lastHighlightedWord = -1;
      const rate = parseFloat(rateSlider.value);
      const wordCount = currentChunkWords.length || 1;
      sysUtteranceDurationEst = Math.max(1.2, (text.length / 13 + wordCount * 0.28) / Math.max(0.35, rate));

      const utt = new SpeechSynthesisUtterance(text);
      utt.voice = picked.voice;
      utt.rate = rate;
      utt.onstart = () => {
        sysUtteranceHighlight = true;
        sysUtteranceT0 = performance.now();
        startSeekerTimer();
      };
      utt.onend = () => {
        sysUtteranceHighlight = false;
        sentenceIdx++;
        speakNext();
      };
      utt.onerror = (ev) => {
        sysUtteranceHighlight = false;
        const err = ev && ev.error;
        if (err === 'interrupted' || err === 'canceled' || err === 'cancelled') return;
        sentenceIdx++;
        speakNext();
      };
      synth.speak(utt);
      currentAudioElement = null;
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
    currentChunkText = text;
    currentChunkWords = text.split(/\s+/).filter(Boolean);
    lastHighlightedWord = -1;
    const rate = parseFloat(rateSlider.value);
    const wordCount = currentChunkWords.length || 1;
    sysUtteranceDurationEst = Math.max(1.2, (text.length / 13 + wordCount * 0.28) / Math.max(0.35, rate));

    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = rate;
    utt.onstart = () => {
      sysUtteranceHighlight = true;
      sysUtteranceT0 = performance.now();
      startSeekerTimer();
    };
    utt.onend = () => {
      sysUtteranceHighlight = false;
      sentenceIdx++;
      speakNext();
    };
    utt.onerror = (ev) => {
      sysUtteranceHighlight = false;
      const err = ev && ev.error;
      if (err === 'interrupted' || err === 'canceled' || err === 'cancelled') return;
      sentenceIdx++;
      speakNext();
    };
    synth.speak(utt);
    currentAudioElement = null;
  }
}

// ── PDF Export ─────────────────────────────────────────────────────────────
document.getElementById('export-pdf').addEventListener('click', () => {
  if (!currentLesson) return;
  const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if (!JsPDF) return;
  try {
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M  = 14, CW = PW - M * 2;
    let y    = M + 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.splitTextToSize(currentLesson.title, CW).forEach(line => {
      if (y > PH - M) { doc.addPage(); y = M + 4; }
      doc.text(line, M, y);
      y += 9;
    });
    doc.setFontSize(8);
    doc.text(currentLesson.url || '', M, y);
    y += 10;
    const body = (currentLesson.content || '').replace(/^#{1,6}\s+/gm, '');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.splitTextToSize(body, CW).forEach(line => {
      if (y > PH - M - 10) { doc.addPage(); y = M + 4; }
      doc.text(line, M, y);
      y += 6.5;
    });
    doc.save(`${currentLesson.title.slice(0, 30)}.pdf`);
  } catch (err) { console.error(err); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
browserAPI.storage.local.get(['currentLesson', 'lexoraConfig'], res => {
  if (res.currentLesson) {
    currentLesson = res.currentLesson;
    applyLesson(currentLesson);
  }
  if (res.lexoraConfig) {
    config = { ...config, ...res.lexoraConfig };
    // Cloud TTS feature was removed — ensure we don't keep stale secrets.
    delete config.ttsKey;
    delete config.aiCleanupOnCapture;
  }
  if (config.kokoroDtype !== 'q4' && config.kokoroDtype !== 'q8') config.kokoroDtype = 'q8';
  document.getElementById('setting-url').value = config.url || '';
  document.getElementById('setting-model').value = config.model || '';
  document.getElementById('setting-key').value = config.key || '';
  if (ttsEngineSelect) ttsEngineSelect.value = config.ttsEngine || 'kokoro';
  if (kokoroDtypeSelect) kokoroDtypeSelect.value = config.kokoroDtype || 'q8';
  updateKokoroDtypeRowVisibility();
  initVoice();
});

document.getElementById('save-settings-btn').addEventListener('click', () => {
  config.url = document.getElementById('setting-url').value.trim();
  config.model = document.getElementById('setting-model').value.trim();
  config.key = document.getElementById('setting-key').value.trim();
  browserAPI.storage.local.set({ lexoraConfig: config }, () => {
    const status = document.getElementById('settings-status');
    status.textContent = '✅ Config Saved';
    initVoice();
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});

if (ttsEngineSelect) {
  ttsEngineSelect.addEventListener('change', () => {
    const nextEngine = ttsEngineSelect.value === 'piper' ? 'piper' : 'kokoro';
    config.ttsEngine = nextEngine;
    cancelAudio(true);
    showDownloadProgress(false);
    populateVoicePicker(nextEngine === 'kokoro' ? Object.keys(KOKORO_VOICE_META) : []);
    updateKokoroDtypeRowVisibility();
    browserAPI.storage.local.set({ lexoraConfig: config });
  });
}

if (kokoroDtypeSelect) {
  kokoroDtypeSelect.addEventListener('change', () => {
    const next = kokoroDtypeSelect.value === 'q4' ? 'q4' : 'q8';
    if (next === config.kokoroDtype) return;
    config.kokoroDtype = next;
    disposeKokoroWorkers();
    browserAPI.storage.local.set({ lexoraConfig: config });
  });
}

if (refreshVoicesBtn) {
  refreshVoicesBtn.addEventListener('click', () => {
    primeSpeechSynthesisVoices();
    if (config.ttsEngine === 'piper') populateVoicePicker([]);
  });
}
