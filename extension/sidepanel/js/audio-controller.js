// audio-controller.js
import '../../protocol.js';
import { encodeWAV, splitIntoChunks } from './utils.js';
import { loadReadingProgressForLesson, saveReadingProgressForLesson } from './progress.js';
import { debugLog, sendRuntimeMessageSafe } from './messaging.js';

function lexoraActions() {
  return (globalThis.LexoraProtocol && LexoraProtocol.ACTIONS) || {
    HIGHLIGHT_WORD: 'highlightWord',
    CLEAR_HIGHLIGHT: 'clearHighlight',
  };
}

const PIPER_MODELS = {
  amy:        { label: 'Amy (low)',                  sampleRate: 16000 },
  hfc_female: { label: 'Google Female EN (medium)',  sampleRate: 22050 },
};

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

const PIPER_CHUNK_MAX_LEN = 320;
const NUM_PIPER_PREFETCH_WORKERS = 2;
const PIPER_PREFETCH_WINDOW = 28;
const PIPER_BUNDLED_PREFIX = 'piper|';
const GOOGLE_VOICE_PREFIX  = 'sys|';
const NUM_PREFETCH_WORKERS = 2;
const PREFETCH_WINDOW = 20;

export class AudioController {
  constructor({ state, dom, browserAPI, addStats }) {
    this.state = state;
    this.dom = dom;
    this.browserAPI = browserAPI;
    this.addStats = addStats;
    this.synth = window.speechSynthesis;

    // Orchestration state
    this.speaking = false;
    this.isPaused = false;
    this.sentences = [];
    this.sentenceIdx = 0;
    this.currentAudioElement = null;
    this.needsResynthOnResume = false;

    // Highlighting state
    this.sysUtteranceDurationEst = 0;
    this.sysUtteranceT0 = 0;
    this.sysUtteranceHighlight = false;
    this.currentChunkText = '';
    this.currentChunkWords = [];
    this.lastHighlightedWord = -1;

    // UI/Timers — audio uses `timeupdate`; system TTS uses rAF (avoids throttled setInterval when tab backgrounded)
    this.seekerTimer = null;
    this._seekerRaf = null;
    this._timeUpdateAudioEl = null;
    this._boundTimeUpdate = null;
    this.pendingAutoplayRetry = false;
    this.progressSaveTimeout = null;
    this.seekDebounce = null;
    this.seekBarDragging = false;
    this.currentSynthesisId = 0;

    // Kokoro state
    this.kokoroWorker = null;
    this.prefetchPool = [];
    this.kokoroReady = false;
    this.kokoroVoices = [];
    this.kokoroLoadedDtype = null;
    this.kokoroLoadGeneration = 0;
    this.audioCache = new Map();
    this.synthQueue = [];
    this.synthCompletedCount = 0;
    this.synthTotalCount = 0;
    this.kokoroLoadPromise = null;

    // Piper state
    this.piperMainWorker = null;
    this.piperPrefetchPool = [];
    this.piperReady = false;
    this.piperSampleRate = 16000;
    this.piperLoadPromise = null;
    this.piperLoadedModelKey = null;
    this.piperAudioCache = new Map();
    this.piperSynthQueue = [];
    this.piperSynthCompletedCount = 0;
    this.piperSynthTotalCount = 0;

    this._bindEvents();
  }

  /** Revoke blob URL created for WAV playback (avoids leaks when play() fails or element is replaced). */
  _revokeLexoraAudioObjectURL(el) {
    if (!el) return;
    const u = el._lexoraObjectUrl;
    if (u) {
      try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ }
      el._lexoraObjectUrl = null;
    } else if (el.src && String(el.src).startsWith('blob:')) {
      try { URL.revokeObjectURL(el.src); } catch (_) { /* ignore */ }
    }
  }

  // --- Event Binding ---
  _bindEvents() {
    document.addEventListener('pointerdown', this.tryAutoplayRetryOnce.bind(this), { capture: true, once: false });
    document.addEventListener('keydown', this.tryAutoplayRetryOnce.bind(this), { capture: true, once: false });

    if (this.synth.addEventListener) {
      this.synth.addEventListener('voiceschanged', () => {
        if (this.state.config.ttsEngine === 'piper') this.populateVoicePicker([]);
        else this.populateVoicePicker(Object.keys(KOKORO_VOICE_META));
      });
    }

    if (this.dom.rateSlider) {
      this.dom.rateSlider.addEventListener('input', () => {
        const val = parseFloat(this.dom.rateSlider.value);
        this.dom.rateLabel.textContent = val.toFixed(2) + '×';
        if (this.currentAudioElement) {
          this.currentAudioElement.playbackRate = val;
        }
      });
    }

    if (this.dom.seekBar) {
      this.dom.seekBar.addEventListener('pointerdown', () => { this.seekBarDragging = true; });
      window.addEventListener('pointerup', () => { this.seekBarDragging = false; });
      
      this.dom.seekBar.addEventListener('input', () => {
        if (this.sentences.length === 0) return;
        
        const pct = parseFloat(this.dom.seekBar.value);
        const floatIdx = (pct / 100) * this.sentences.length;
        const newIdx = Math.floor(floatIdx);
        
        if (newIdx === this.sentenceIdx && this.currentAudioElement && !this.isPaused) {
          if (this.currentAudioElement.duration) {
            const subProgress = floatIdx - newIdx;
            this.currentAudioElement.currentTime = subProgress * this.currentAudioElement.duration;
            return;
          }
        }

        if (this.seekDebounce) clearTimeout(this.seekDebounce);
        this.seekDebounce = setTimeout(() => {
          this.cancelAudio(false);
          this.sentenceIdx = Math.min(this.sentences.length - 1, newIdx);
          this.isPaused = false;
          this.speaking = true;
          if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';
          this.saveReadingProgress();
          this.speakNext();
        }, 80);
      });
    }

    if (this.dom.voicePicker) {
      this.dom.voicePicker.addEventListener('change', () => {
        const wasSpeaking = this.speaking;
        const wasPaused = this.isPaused;
        this.cancelAudio(true);

        if (wasSpeaking) {
          this.speaking = true;
          this.isPaused = false;
          if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';
          this.speakNext();
        } else if (wasPaused) {
          this.needsResynthOnResume = true;
        }
      });
    }

    if (this.dom.prevBtn) {
      this.dom.prevBtn.addEventListener('click', () => this.prevSentence());
    }
    if (this.dom.nextBtn) {
      this.dom.nextBtn.addEventListener('click', () => this.nextSentence());
    }
    if (this.dom.playBtn) {
      this.dom.playBtn.addEventListener('click', () => this.togglePlayback());
    }
  }

  // --- Playback Commands ---
  async togglePlayback() {
    if (!this.state.currentLesson) return;

    if (this.dom.playBtn && (this.dom.playBtn.disabled || /⏳\s*Loading/i.test(this.dom.playBtn.textContent || ''))) return;

    if (this.speaking) {
      this.pause();
      return;
    }

    if (this.isPaused) {
      this.resume();
      return;
    }

    this.startPlayback();
  }

  pause() {
    if (this.currentAudioElement && typeof this.currentAudioElement.pause === 'function') {
      try { this.currentAudioElement.pause(); }
      catch (err) { debugLog('AudioController', 'pause() on audio element failed', err); }
    } else {
      this.synth.cancel();
    }
    this.speaking = false;
    this.isPaused = true;
    if(this.dom.playBtn) this.dom.playBtn.textContent = '▶ Resume';
    this.stopSeekerTimer();
    this.saveReadingProgress();
    // Intentionally DO NOT clear highlight state on pause — keep the active
    // span visible and `currentChunkText/Words/lastHighlightedWord` populated
    // so resume() picks up exactly where it left off. Full clears still happen
    // through cancelAudio() on seek/voice-change/next/prev.
  }

  async resume() {
    this.isPaused = false;
    this.speaking = true;
    if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';

    if (this.needsResynthOnResume) {
      this.needsResynthOnResume = false;
      this.speakNext();
      return;
    }

    if (this.currentAudioElement && typeof this.currentAudioElement.play === 'function') {
      try {
        await this.currentAudioElement.play();
        this.startSeekerTimer();
      } catch (err) {
        debugLog('AudioController', 'resume() play failed', err);
        const el = this.currentAudioElement;
        if (el) this._revokeLexoraAudioObjectURL(el);
        this.currentAudioElement = null;
        this.speakNext();
      }
      return;
    }

    this.speakNext();
  }

  prevSentence() {
    if (this.sentences.length === 0) return;
    this.cancelAudio();
    this.sentenceIdx = Math.max(0, this.sentenceIdx - 1);
    this.saveReadingProgress();
    if (this.speaking) {
      this.isPaused = false;
      this.speakNext();
    }
  }

  nextSentence() {
    if (this.sentences.length === 0) return;
    this.cancelAudio();
    this.sentenceIdx = Math.min(this.sentences.length - 1, this.sentenceIdx + 1);
    this.saveReadingProgress();
    if (this.speaking) {
      this.isPaused = false;
      this.speakNext();
    }
  }

  startPlayback() {
    if (!this.state.currentLesson) return;
    if (this.speaking) return;

    this.speaking = true;
    this.isPaused = false;
    if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';

    if (this.sentences.length === 0) {
      const plain = (this.state.currentLesson.content || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/^[-*]\s+/gm, '');
      const maxChunk = this.state.config.ttsEngine === 'piper' ? PIPER_CHUNK_MAX_LEN : 120;
      this.sentences = splitIntoChunks(plain, maxChunk);
    }

    if (this.sentenceIdx >= this.sentences.length) {
      this.sentenceIdx = 0;
    }

    this.speakNext();
  }

  resetNarrationForNewLesson() {
    this.cancelAudio(true);
    this.sentences = [];
    this.sentenceIdx = 0;
    this.speaking = false;
    this.isPaused = false;
    this.needsResynthOnResume = false;
    
    if (this.dom.playBtn) this.dom.playBtn.textContent = '▶ Play';
    if (this.dom.seekBar) this.dom.seekBar.value = 0;

    if (this.state.currentLesson && this.state.currentLesson.url && this.state.currentLesson.title !== 'Selected Text') {
      loadReadingProgressForLesson(this.browserAPI, this.state.currentLesson).then((v) => {
        if (v === null || v === undefined) return;
        this.sentenceIdx = v;
        if (this.sentences.length > 0 && this.dom.seekBar) {
          this.dom.seekBar.value = (this.sentenceIdx / this.sentences.length) * 100;
        }
      }).catch(err => debugLog('AudioController', 'Storage set failed', err));
    }
  }

  cancelAudio(clearCache = false) {
    this.currentSynthesisId++;
    this.sysUtteranceHighlight = false;
    if (this.kokoroWorker) {
      try { this.kokoroWorker.postMessage({ type: 'cancel' }); }
      catch (err) { debugLog('AudioController', 'kokoro main worker cancel failed', err); }
    }
    for (const w of this.prefetchPool) {
      try { w.postMessage({ type: 'cancel' }); }
      catch (err) { debugLog('AudioController', 'kokoro prefetch worker cancel failed', err); }
    }
    this.synthQueue = [];
    this.stopSeekerTimer();
    this.sendClearHighlight(true);
    if (this.currentAudioElement) {
      try {
        if (typeof this.currentAudioElement.pause === 'function') this.currentAudioElement.pause();
        this._revokeLexoraAudioObjectURL(this.currentAudioElement);
      } catch (err) {
        debugLog('AudioController', 'cancelAudio cleanup failed', err);
      }
      this.currentAudioElement = null;
    }
    this.synth.cancel();
    if (clearCache) {
      this.audioCache.forEach(v => { if (v && v.url) URL.revokeObjectURL(v.url); });
      this.audioCache.clear();
      this.synthCompletedCount = 0;
      this.synthTotalCount = 0;
      this.piperAudioCache.clear();
      this.piperSynthQueue = [];
      this.piperSynthCompletedCount = 0;
      this.piperSynthTotalCount = 0;
    } else {
      for (const [k, v] of this.audioCache) {
        if (v == null) this.audioCache.delete(k);
      }
      for (const [k, v] of this.piperAudioCache) {
        if (v == null) this.piperAudioCache.delete(k);
      }
    }
  }

  // --- Seek / Progress ---
  startSeekerTimer() {
    this.stopSeekerTimer();
    if (this.currentAudioElement) {
      const el = this.currentAudioElement;
      this._timeUpdateAudioEl = el;
      this._boundTimeUpdate = () => this.updateSeekBar();
      el.addEventListener('timeupdate', this._boundTimeUpdate);
      this.updateSeekBar();
      return;
    }
    if (this.sysUtteranceHighlight) {
      const tick = () => {
        if (!this.sysUtteranceHighlight || !this.speaking) {
          this._seekerRaf = null;
          return;
        }
        this.updateSeekBar();
        this._seekerRaf = globalThis.requestAnimationFrame(tick);
      };
      this._seekerRaf = globalThis.requestAnimationFrame(tick);
      return;
    }
    this.seekerTimer = setInterval(() => this.updateSeekBar(), 100);
  }

  stopSeekerTimer() {
    if (this.seekerTimer) {
      clearInterval(this.seekerTimer);
      this.seekerTimer = null;
    }
    if (this._seekerRaf != null) {
      globalThis.cancelAnimationFrame(this._seekerRaf);
      this._seekerRaf = null;
    }
    const el = this._timeUpdateAudioEl;
    if (el && this._boundTimeUpdate) {
      try {
        el.removeEventListener('timeupdate', this._boundTimeUpdate);
      } catch (_) { /* detached node */ }
    }
    this._timeUpdateAudioEl = null;
    this._boundTimeUpdate = null;
  }

  updateSeekBar() {
    if (!this.sentences.length) return;

    let itemProgress = 0;
    if (this.currentAudioElement) {
      const rawDur = this.currentAudioElement.duration;
      const fallbackDur = this.currentAudioElement._lexoraDur;
      const dur = rawDur && isFinite(rawDur) && rawDur > 0 ? rawDur : fallbackDur && fallbackDur > 0 ? fallbackDur : 0;
      if (dur > 0) {
        const t = this.currentAudioElement.currentTime;
        itemProgress = (t && isFinite(t) ? t : 0) / dur;
      }
    } else if (this.sysUtteranceHighlight && this.sysUtteranceDurationEst > 0) {
      const elapsed = (performance.now() - this.sysUtteranceT0) / 1000;
      itemProgress = Math.min(1, elapsed / this.sysUtteranceDurationEst);
    } else {
      return;
    }

    const total = this.sentences.length;
    const progress = ((this.sentenceIdx + itemProgress) / total) * 100;

    if (!this.seekBarDragging && this.dom.seekBar) {
      this.dom.seekBar.value = progress;
    }

    // Word tracking
    const durForWords = this.currentAudioElement && this.currentAudioElement.duration && isFinite(this.currentAudioElement.duration) && this.currentAudioElement.duration > 0
        ? this.currentAudioElement.duration
        : this.currentAudioElement && this.currentAudioElement._lexoraDur
          ? this.currentAudioElement._lexoraDur
          : this.sysUtteranceHighlight
            ? this.sysUtteranceDurationEst
            : 0;

    if (this.currentChunkWords.length && durForWords > 0) {
      let totalChars = 0;
      const charPositions = [];
      for (const w of this.currentChunkWords) {
        charPositions.push(totalChars);
        totalChars += w.length;
      }
      const charProgress = Math.min(1, itemProgress) * totalChars;
      let wordIdx = 0;
      for (let i = 0; i < charPositions.length; i++) {
        if (charPositions[i] <= charProgress) wordIdx = i;
      }
      wordIdx = Math.min(wordIdx, this.currentChunkWords.length - 1);

      if (wordIdx !== this.lastHighlightedWord) {
        this.lastHighlightedWord = wordIdx;
        const A = lexoraActions();
        sendRuntimeMessageSafe(this.browserAPI, {
          action: A.HIGHLIGHT_WORD,
          chunkText: this.currentChunkText,
          wordIndex: wordIdx,
        }).then((w) => {
          if (!w?.ok) debugLog('AudioController', 'highlightWord relay failed', w?.error);
        });
      }
    }
  }

  saveReadingProgress() {
    if (!this.state.currentLesson || !this.state.currentLesson.url) return;
    if (this.state.currentLesson.title === 'Selected Text') return;

    const snapUrl = this.state.currentLesson.url;
    const snapTitle = this.state.currentLesson.title;
    const snapIdx = this.sentenceIdx;

    clearTimeout(this.progressSaveTimeout);
    this.progressSaveTimeout = setTimeout(() => {
      this.progressSaveTimeout = null;
      const L = this.state.currentLesson;
      if (!L || L.url !== snapUrl || L.title !== snapTitle) return;
      saveReadingProgressForLesson(this.browserAPI, L, snapIdx);
    }, 400);
  }

  sendClearHighlight(fullReset = false) {
    this.currentChunkWords = [];
    this.currentChunkText = '';
    this.lastHighlightedWord = -1;
    const A = lexoraActions();
    sendRuntimeMessageSafe(this.browserAPI, { action: A.CLEAR_HIGHLIGHT, fullReset }).then((w) => {
      if (!w?.ok) debugLog('AudioController', 'clearHighlight relay failed', w?.error);
    });
  }

  // --- Voice UI / Parsing ---
  initVoice(tries = 0) {
    if (this.state.config.ttsEngine === 'piper') {
      this.primeSpeechSynthesisVoices();
      if (this.synth.getVoices().length > 0 || tries >= 40) {
        this.populateVoicePicker([]);
      } else {
        setTimeout(() => this.initVoice(tries + 1), 250);
      }
      return;
    }

    const all = this.synth.getVoices();
    if (all.length > 0 || tries >= 40) {
      this.populateVoicePicker(Object.keys(KOKORO_VOICE_META));
    } else {
      setTimeout(() => this.initVoice(tries + 1), 250);
    }
  }

  updateKokoroDtypeRowVisibility() {
    if (!this.dom.kokoroDtypeRow) return;
    this.dom.kokoroDtypeRow.style.display = this.state.config.ttsEngine === 'kokoro' ? 'block' : 'none';
  }

  showDownloadProgress(show) {
    if (this.dom.downloadProgress) {
      this.dom.downloadProgress.style.display = show ? 'block' : 'none';
    }
  }

  updateDownloadProgress(progress) {
    if (!progress || !this.dom.downloadBar) return;

    if (progress.status === 'progress' && progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      this.dom.downloadBar.style.width = pct + '%';
      const mb = (progress.loaded / 1024 / 1024).toFixed(1);
      const totalMb = (progress.total / 1024 / 1024).toFixed(1);
      if (this.dom.downloadText) this.dom.downloadText.textContent = `Downloading model… ${mb}/${totalMb} MB (${pct}%)`;
    } else if (progress.status === 'ready') {
      this.dom.downloadBar.style.width = '100%';
      if (this.dom.downloadText) this.dom.downloadText.textContent = 'Model ready!';
      setTimeout(() => this.showDownloadProgress(false), 1500);
    } else if (progress.status === 'initiate') {
      const name = progress.file || progress.name || '';
      if (this.dom.downloadText) this.dom.downloadText.textContent = `Loading ${name}…`;
    }
  }

  primeSpeechSynthesisVoices() {
    let list = this.synth.getVoices();
    if (list.length > 0) return list;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
      this.synth.cancel();
    } catch (err) {
      debugLog('AudioController', 'primeSpeechSynthesisVoices failed', err);
    }
    return this.synth.getVoices();
  }

  isLikelyNoveltyOrEffectVoice(v) {
    const n = v.name.trim().toLowerCase();
    const uri = (v.voiceURI || '').toLowerCase();
    const comic = [
      'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news',
      'hysterical', 'junior', 'kathy', 'pipe organ', 'trinoids', 'whisper', 'zarvox',
      'deranged', 'superstar', 'phonetic', 'shelley', 'grandma', 'grandpa', 'reed (english',
      'rocko', 'sandy',
    ];
    for (const s of comic) {
      if (n === s || n.includes(s)) return true;
    }
    if (/\b(junior|kathy)\b/.test(n) && !/siri|google|microsoft|samantha|daniel|karen/i.test(n)) return true;
    if (/emoji|chipmunk|monster|announcer|broadcast|novelty|demo voice/i.test(n + uri)) return true;
    return false;
  }

  findGoogleFemaleEnVoice() {
    const all = this.synth.getVoices();
    const compact = (s) => s.replace(/\s+/g, ' ').trim();
    return (
      all.find((v) => /google\s*female\s*en\b/i.test(compact(v.name))) ||
      all.find((v) => /google.*female.*\ben\b/i.test(compact(v.name))) ||
      null
    );
  }

  findGoogleFemaleEnglishVoice() {
    const all = this.synth.getVoices();
    const gfEn = this.findGoogleFemaleEnVoice();
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

  findGoogleVoice() {
    const all = this.synth.getVoices();
    return (
      this.findGoogleFemaleEnVoice() ||
      this.findGoogleFemaleEnglishVoice() ||
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

  parsePiperOrSystemVoice(value) {
    if (value.startsWith(PIPER_BUNDLED_PREFIX)) {
      const modelKey = value.slice(PIPER_BUNDLED_PREFIX.length) || 'amy';
      return { kind: 'piper', modelKey };
    }
    if (value.startsWith(GOOGLE_VOICE_PREFIX)) {
      try {
        const uri = decodeURIComponent(value.slice(GOOGLE_VOICE_PREFIX.length));
        const all = this.synth.getVoices();
        let v = all.find((x) => x.voiceURI === uri);
        if (!v) v = all.find((x) => x.name === uri);
        return v ? { kind: 'system', voice: v } : { kind: 'system', voice: null };
      } catch (_) {
        return { kind: 'system', voice: null };
      }
    }
    if (value.startsWith('piper:')) return { kind: 'piper', modelKey: 'amy' };
    return { kind: 'piper', modelKey: 'amy' };
  }

  populateVoicePicker(availableVoiceIds) {
    if(!this.dom.voicePicker) return;
    this.dom.voicePicker.innerHTML = '';

    if (this.state.config.ttsEngine === 'piper') {
      const piperGroup = document.createElement('optgroup');
      piperGroup.label = 'Piper (offline — downloads on first use)';

      const amy = document.createElement('option');
      amy.value = `${PIPER_BUNDLED_PREFIX}amy`;
      amy.textContent = 'Amy — Low';
      piperGroup.appendChild(amy);

      const hfcFemale = document.createElement('option');
      hfcFemale.value = `${PIPER_BUNDLED_PREFIX}hfc_female`;
      hfcFemale.textContent = '⭐ Google Female EN — Medium';
      hfcFemale.selected = true; // Set as default for Piper
      piperGroup.appendChild(hfcFemale);

      this.dom.voicePicker.appendChild(piperGroup);

      const systemVoices = this.synth.getVoices()
        .filter((v) => /^en/i.test(v.lang || '') && !this.isLikelyNoveltyOrEffectVoice(v))
        .slice(0, 6);
      const preferredSystemVoice = this.findGoogleVoice();
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
        this.dom.voicePicker.appendChild(systemGroup);
      }
      return;
    }

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
      const key = (meta.accent === 'UK' ? '🇬🇧 British' : '🇺🇸 American') + (meta.gender === 'F' ? ' Female' : ' Male');
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
      this.dom.voicePicker.appendChild(optGroup);
    }

    const heartOpt = this.dom.voicePicker.querySelector('option[value="kokoro:af_heart"]');
    if (heartOpt) {
      heartOpt.selected = true;
    } else {
      // Fallback: select the first available Kokoro voice if heart is missing
      const firstKokoro = this.dom.voicePicker.querySelector('option[value^="kokoro:"]');
      if (firstKokoro) firstKokoro.selected = true;
    }
  }

  // --- Worker Lifecycle ---
  disposeKokoroWorkers() {
    this.kokoroLoadGeneration++;
    this.cancelAudio(true);
    // worker.terminate() can throw if the worker is already torn down;
    // these catches are intentionally silent best-effort cleanup.
    if (this.kokoroWorker) {
      try { this.kokoroWorker.terminate(); } catch (_) { /* already terminated */ }
      this.kokoroWorker = null;
    }
    for (const w of this.prefetchPool) {
      try { w.terminate(); } catch (_) { /* already terminated */ }
    }
    this.prefetchPool = [];
    this.kokoroReady = false;
    this.kokoroVoices = [];
    this.kokoroLoadedDtype = null;
    this.kokoroLoadPromise = null;
  }

  resolveKokoroDtype() {
    return this.state.config.kokoroDtype === 'q4' ? 'q4' : 'q8';
  }

  createKokoroWorker() {
    return new Worker(
      this.browserAPI.runtime.getURL('sidepanel/kokoro-worker.js'),
      { type: 'module' }
    );
  }

  initKokoroWorkerInstance(worker, label, dtype = 'q8') {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 300000);

      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          this.updateDownloadProgress(msg.progress);
        } else if (msg.type === 'initialized') {
          clearTimeout(timeout);
          debugLog('AudioController', `${label} ready. ${(msg.voices || []).length} voices.`);
          resolve(msg.voices || []);
        } else if (msg.type === 'log') {
          debugLog('AudioController', `${label}: ${msg.message}`);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(msg.error));
        }
      };

      worker.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };

      worker.postMessage({ type: 'init', dtype, device: 'wasm' });
    });
  }

  async loadKokoroModel() {
    const wantDtype = this.resolveKokoroDtype();
    if (this.kokoroReady && this.kokoroLoadedDtype === wantDtype) return true;
    if (this.kokoroLoadPromise) return this.kokoroLoadPromise;

    if (this.kokoroWorker || this.prefetchPool.length || (this.kokoroReady && this.kokoroLoadedDtype !== wantDtype)) {
      this.disposeKokoroWorkers();
    }

    this.kokoroLoadPromise = (async () => {
      const loadSnapshot = this.kokoroLoadGeneration;
      const dtype = this.resolveKokoroDtype();
      if(this.dom.statusLabel) this.dom.statusLabel.textContent = '🧠 Loading Kokoro Neural Engine…';
      this.showDownloadProgress(true);
      debugLog('AudioController', `Loading Kokoro (${dtype}, 1 main + ${NUM_PREFETCH_WORKERS} prefetch workers)…`);

      try {
        this.kokoroWorker = this.createKokoroWorker();
        const voices = await this.initKokoroWorkerInstance(this.kokoroWorker, 'Main', dtype);
        if (loadSnapshot !== this.kokoroLoadGeneration) return false;
        this.kokoroWorker.onmessage = this.handleKokoroWorkerMessage.bind(this);

        this.prefetchPool = [];
        const prefetchWorkers = Array.from({ length: NUM_PREFETCH_WORKERS }, () => this.createKokoroWorker());
        await Promise.all(prefetchWorkers.map((w, i) => this.initKokoroWorkerInstance(w, `Pool-${i}`, dtype)));
        if (loadSnapshot !== this.kokoroLoadGeneration) return false;
        for (const w of prefetchWorkers) {
          w.onmessage = this.handleKokoroWorkerMessage.bind(this);
          this.prefetchPool.push(w);
        }

        if (loadSnapshot !== this.kokoroLoadGeneration) return false;
        this.kokoroReady = true;
        this.kokoroLoadedDtype = dtype;
        this.kokoroVoices = voices;
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        this.showDownloadProgress(false);
        if (this.kokoroVoices.length) this.populateVoicePicker(this.kokoroVoices);

        return true;
      } catch (e) {
        if (loadSnapshot === this.kokoroLoadGeneration) {
          debugLog(`Kokoro load error: ${e.message}`, 'error');
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = '❌ ' + e.message;
          this.showDownloadProgress(false);
          if (this.kokoroWorker) {
            try { this.kokoroWorker.terminate(); } catch (_) { /* already terminated */ }
            this.kokoroWorker = null;
          }
          for (const w of this.prefetchPool) {
            try { w.terminate(); } catch (_) { /* already terminated */ }
          }
          this.prefetchPool = [];
          this.kokoroReady = false;
          this.kokoroLoadedDtype = null;
        }
        this.kokoroLoadPromise = null;
        return false;
      }
    })();

    return this.kokoroLoadPromise;
  }

  disposePiperWorkers() {
    // worker.terminate() can throw if the worker was already torn down by
    // a previous load failure; these catches are intentional best-effort cleanup.
    if (this.piperMainWorker) {
      try { this.piperMainWorker.terminate(); } catch (_) { /* already terminated */ }
      this.piperMainWorker = null;
    }
    for (const w of this.piperPrefetchPool) {
      try { w.terminate(); } catch (_) { /* already terminated */ }
    }
    this.piperPrefetchPool = [];
  }

  createPiperWorker() {
    return new Worker(this.browserAPI.runtime.getURL('sidepanel/piper-worker.js'));
  }

  initPiperWorkerInstance(worker, modelKey) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Piper init timed out')), 300000);
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'initialized') {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'progress') {
          this.updateDownloadProgress(msg.progress);
        } else if (msg.type === 'log') {
          debugLog('AudioController', `Piper: ${msg.message}`);
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

  async loadPiperModel(modelKey = 'amy') {
    if (this.piperReady && this.piperLoadedModelKey === modelKey) return true;

    if (this.piperReady || this.piperLoadPromise) {
      this.disposePiperWorkers();
      this.piperReady = false;
      this.piperLoadPromise = null;
      this.piperLoadedModelKey = null;
    }

    const modelMeta = PIPER_MODELS[modelKey] || PIPER_MODELS.amy;
    this.piperSampleRate = modelMeta.sampleRate;

    this.piperLoadPromise = (async () => {
      if(this.dom.statusLabel) this.dom.statusLabel.textContent = `🧠 Loading Piper (${modelMeta.label})…`;
      this.showDownloadProgress(true);
      debugLog('AudioController', `Loading Piper on-demand (${modelMeta.label}, 1 main + ${NUM_PIPER_PREFETCH_WORKERS} prefetch)…`);
      try {
        this.piperMainWorker = this.createPiperWorker();
        await this.initPiperWorkerInstance(this.piperMainWorker, modelKey);

        this.piperPrefetchPool = [];
        const prefetchWorkers = [];
        for (let i = 0; i < NUM_PIPER_PREFETCH_WORKERS; i++) prefetchWorkers.push(this.createPiperWorker());
        await Promise.all(prefetchWorkers.map((w) => this.initPiperWorkerInstance(w, modelKey)));
        this.piperPrefetchPool = prefetchWorkers;

        const attach = (w) => {
          w.onmessage = this.handlePiperWorkerMessage.bind(this);
        };
        attach(this.piperMainWorker);
        for (const w of this.piperPrefetchPool) attach(w);

        this.piperReady = true;
        this.piperLoadedModelKey = modelKey;
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        this.showDownloadProgress(false);
        return true;
      } catch (e) {
        debugLog(`Piper load error: ${e.message}`, 'error');
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '❌ ' + e.message;
        this.showDownloadProgress(false);
        this.disposePiperWorkers();
        this.piperLoadPromise = null;
        this.piperLoadedModelKey = null;
        return false;
      }
    })();

    return this.piperLoadPromise;
  }

  // --- Synthesis Logic ---
  dispatchNextPiperWorker(worker) {
    while (this.piperSynthQueue.length) {
      const idx = this.piperSynthQueue.shift();
      const existing = this.piperAudioCache.get(idx);
      if (existing && existing.blob) continue;
      if (existing === null) this.piperAudioCache.delete(idx);
      this.piperAudioCache.set(idx, null);
      worker.postMessage({
        type: 'synthesize',
        text: this.sentences[idx].trim(),
        requestId: this.currentSynthesisId,
        prefetchIdx: idx,
      });
      return;
    }
  }

  synthesizeAllPiper(fromIdx = 0) {
    if (!this.piperReady || !this.piperMainWorker) return;
    this.piperSynthQueue = [];
    this.piperSynthCompletedCount = 0;

    const capIdx = Math.min(fromIdx + PIPER_PREFETCH_WINDOW, this.sentences.length);
    const priority = [];
    for (let i = fromIdx; i < capIdx; i++) {
      const entry = this.piperAudioCache.get(i);
      if (entry && entry.blob) {
        this.piperSynthCompletedCount++;
        continue;
      }
      if (entry === null) this.piperAudioCache.delete(i);
      if (i === this.sentenceIdx) {
        priority.unshift(i);
      } else {
        priority.push(i);
      }
    }
    this.piperSynthQueue = priority;
    this.piperSynthTotalCount = this.piperSynthCompletedCount + this.piperSynthQueue.length;

    const allWorkers = [this.piperMainWorker, ...this.piperPrefetchPool];
    for (const w of allWorkers) {
      this.dispatchNextPiperWorker(w);
    }
  }

  handlePiperWorkerMessage(e) {
    const msg = e.data;
    if (msg.requestId != null && msg.requestId !== this.currentSynthesisId) return;

    if (msg.type === 'audio') {
      const audioSamples = msg.data instanceof Float32Array ? msg.data : new Float32Array(msg.data || []);
      if (audioSamples.length === 0) return;
      const blob = encodeWAV(audioSamples, this.piperSampleRate);

      if (msg.prefetchIdx != null) {
        this.piperAudioCache.set(msg.prefetchIdx, { blob, sampleRate: this.piperSampleRate });
        this.piperSynthCompletedCount++;
        if (this.piperSynthCompletedCount < this.piperSynthTotalCount) {
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = `Synthesizing ${this.piperSynthCompletedCount}/${this.piperSynthTotalCount}…`;
        } else {
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        }
        this.dispatchNextPiperWorker(e.target);

        if (msg.prefetchIdx === this.sentenceIdx && this.speaking && !this.currentAudioElement) {
          this.playFromBlob(blob, this.piperSampleRate, 'piper');
        } else if (this.speaking && !this.currentAudioElement && this.piperAudioCacheHasBlob(this.sentenceIdx)) {
          const c = this.piperAudioCache.get(this.sentenceIdx);
          this.playFromBlob(c.blob, c.sampleRate, 'piper');
        }
      } else {
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        this.playFromBlob(blob, this.piperSampleRate, 'piper');
      }
    } else if (msg.type === 'error') {
      if (msg.prefetchIdx != null) {
        this.piperAudioCache.delete(msg.prefetchIdx);
        this.dispatchNextPiperWorker(e.target);
        if (this.speaking) this.synthesizeAllPiper(this.sentenceIdx);
      } else {
        debugLog(`Piper synthesis error: ${msg.error}`, 'error');
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        if (this.speaking && msg.requestId === this.currentSynthesisId) {
          this.advanceSentence();
          this.speakNext();
        }
      }
    } else if (msg.type === 'log') {
      debugLog('AudioController', `Piper: ${msg.message}`);
    }
  }

  piperAudioCacheHasBlob(idx) {
    const e = this.piperAudioCache.get(idx);
    return !!(e && e.blob);
  }

  dispatchNextToWorker(worker, voiceId) {
    while (this.synthQueue.length) {
      const idx = this.synthQueue.shift();
      const existing = this.audioCache.get(idx);
      if (existing && existing.blob) continue;
      if (existing === null) this.audioCache.delete(idx);
      this.audioCache.set(idx, null);
      worker.postMessage({
        type: 'prefetch',
        text: this.sentences[idx].trim(),
        voice: voiceId,
        requestId: this.currentSynthesisId,
        prefetchIdx: idx,
      });
      return;
    }
  }

  synthesizeAll(voiceId, fromIdx = 0) {
    if (!this.kokoroReady) return;
    this.synthQueue = [];
    this.synthCompletedCount = 0;

    const capIdx = Math.min(fromIdx + PREFETCH_WINDOW, this.sentences.length);
    const priority = [];
    for (let i = fromIdx; i < capIdx; i++) {
      const entry = this.audioCache.get(i);
      if (entry && entry.blob) {
        this.synthCompletedCount++;
        continue;
      }
      if (entry === null) this.audioCache.delete(i);
      if (i === this.sentenceIdx) {
        priority.unshift(i);
      } else {
        priority.push(i);
      }
    }
    this.synthQueue = priority;
    this.synthTotalCount = this.synthCompletedCount + this.synthQueue.length;

    const allWorkers = [this.kokoroWorker, ...this.prefetchPool];
    for (const w of allWorkers) {
      this.dispatchNextToWorker(w, voiceId);
    }
  }

  handleKokoroWorkerMessage(e) {
    const msg = e.data;
    if (msg.requestId != null && msg.requestId !== this.currentSynthesisId) return;

    if (msg.type === 'audio') {
      const sampleRate = msg.sampleRate || 24000;
      const audioSamples = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);

      if (audioSamples.length === 0) return;

      const blob = encodeWAV(audioSamples, sampleRate);
      const voiceId = this.dom.voicePicker?.value.split(':')[1];

      if (msg.prefetchIdx != null) {
        this.audioCache.set(msg.prefetchIdx, { blob, sampleRate });
        this.synthCompletedCount++;

        if (this.synthCompletedCount < this.synthTotalCount) {
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = `Synthesizing ${this.synthCompletedCount}/${this.synthTotalCount}…`;
        } else {
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        }

        this.dispatchNextToWorker(e.target, voiceId);

        if (msg.prefetchIdx === this.sentenceIdx && this.speaking && !this.currentAudioElement) {
          this.playFromBlob(blob, sampleRate, voiceId);
        } else if (this.speaking && !this.currentAudioElement && this.audioCacheHasBlob(this.sentenceIdx)) {
          const c = this.audioCache.get(this.sentenceIdx);
          this.playFromBlob(c.blob, c.sampleRate, voiceId);
        }
      } else {
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        this.playFromBlob(blob, sampleRate, voiceId);
      }
    } else if (msg.type === 'discarded') {
      if (msg.prefetchIdx != null) this.audioCache.delete(msg.prefetchIdx);
      const sel = this.dom.voicePicker?.value || '';
      if (!sel.startsWith('kokoro:')) return;
      const voiceId = sel.split(':')[1];
      this.dispatchNextToWorker(e.target, voiceId);
      if (this.speaking) this.synthesizeAll(voiceId, this.sentenceIdx);
    } else if (msg.type === 'error') {
      const voiceId = this.dom.voicePicker?.value.split(':')[1];
      if (msg.prefetchIdx != null) {
        this.audioCache.delete(msg.prefetchIdx);
        this.dispatchNextToWorker(e.target, voiceId);
      } else {
        debugLog(`Synthesis error: ${msg.error}`, 'error');
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        if (this.speaking) { this.advanceSentence(); this.speakNext(); }
      }
    } else if (msg.type === 'log') {
      debugLog('AudioController', `Worker: ${msg.message}`);
    } else if (msg.type === 'progress') {
      this.updateDownloadProgress(msg.progress);
    }
  }

  audioCacheHasBlob(idx) {
    const e = this.audioCache.get(idx);
    return !!(e && e.blob);
  }

  playFromBlob(blob, sampleRate, _voiceId) {
    this.sysUtteranceHighlight = false;
    const url = URL.createObjectURL(blob);
    this.currentAudioElement = new Audio(url);
    this.currentAudioElement._lexoraObjectUrl = url;
    if(this.dom.rateSlider) this.currentAudioElement.playbackRate = parseFloat(this.dom.rateSlider.value);
    // Older browsers may not implement preservesPitch / volume setters; ignore.
    try { this.currentAudioElement.preservesPitch = true; } catch (_) { /* unsupported */ }
    try { this.currentAudioElement.muted = false; this.currentAudioElement.volume = 1; } catch (_) { /* unsupported */ }
    const pcmBytes = Math.max(0, blob.size - 44);
    this.currentAudioElement._lexoraDur = pcmBytes / (sampleRate * 2);

    const text = this.sentences[this.sentenceIdx] || '';
    this.currentChunkText = text.trim();
    this.currentChunkWords = this.currentChunkText.split(/\s+/).filter(Boolean);
    this.lastHighlightedWord = -1;
    const chunkWordCount = this.currentChunkWords.length || 1;

    this.currentAudioElement.addEventListener(
      'durationchange',
      () => {
        const d = this.currentAudioElement.duration;
        if (d && isFinite(d) && d > 0) this.currentAudioElement._lexoraDur = d;
      },
      { once: true }
    );

    this.currentAudioElement.onerror = () => {
      const el = this.currentAudioElement;
      this.stopSeekerTimer();
      if (el) this._revokeLexoraAudioObjectURL(el);
      this.currentAudioElement = null;
      debugLog('AudioController', 'Audio element error', null);
      if (this.speaking) this.speakNext();
    };

    this.currentAudioElement.onended = () => {
      const durSec = this.currentAudioElement?._lexoraDur || this.currentAudioElement?.duration || 0;
      const durMs = isFinite(durSec) && durSec > 0 ? durSec * 1000 : 0;

      this.stopSeekerTimer();
      if (this.currentAudioElement) this._revokeLexoraAudioObjectURL(this.currentAudioElement);
      this.sendClearHighlight();
      if (this.speaking) {
        this.advanceSentence(chunkWordCount, durMs);
        this.currentAudioElement = null;
        this.speakNext();
      } else {
        this.currentAudioElement = null;
        this.stopSeekerTimer();
      }
    };

    if (this.speaking) {
      const p = this.currentAudioElement.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          debugLog(`Audio play blocked: ${err?.message || err}`, 'error');
          const el = this.currentAudioElement;
          if (el) this._revokeLexoraAudioObjectURL(el);
          this.currentAudioElement = null;
          this.armAutoplayRetry();
        });
      }
      this.startSeekerTimer();
    }
  }

  speakWithSystemVoice(text, voice, rate) {
    this.currentChunkText = text;
    this.currentChunkWords = text.split(/\s+/).filter(Boolean);
    this.lastHighlightedWord = -1;
    const wordCount = this.currentChunkWords.length || 1;
    this.sysUtteranceDurationEst = Math.max(1.2, (text.length / 13 + wordCount * 0.28) / Math.max(0.35, rate));

    const utt = new SpeechSynthesisUtterance(text);
    if (voice) utt.voice = voice;
    utt.rate = rate;
    utt.onstart = () => {
      this.sysUtteranceHighlight = true;
      this.sysUtteranceT0 = performance.now();
      this.startSeekerTimer();
    };
    utt.onend = () => {
      this.sysUtteranceHighlight = false;
      this.advanceSentence();
      this.speakNext();
    };
    utt.onerror = (ev) => {
      this.sysUtteranceHighlight = false;
      const err = ev && ev.error;
      if (err === 'interrupted' || err === 'canceled' || err === 'cancelled') return;
      this.advanceSentence();
      this.speakNext();
    };
    this.synth.speak(utt);
    this.currentAudioElement = null;
  }

  async speakNext() {
    if (!this.speaking || this.sentenceIdx >= this.sentences.length) {
      this.speaking = false;
      if(this.dom.playBtn) this.dom.playBtn.textContent = '▶ Play';
      if(this.dom.seekBar) this.dom.seekBar.value = 100;
      if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
      this.sendClearHighlight(true);
      return;
    }
    
    const pct = Math.round((this.sentenceIdx / this.sentences.length) * 100);
    if(this.dom.seekBar) this.dom.seekBar.value = pct;
    
    const text = this.sentences[this.sentenceIdx].trim();
    const selectedValue = this.dom.voicePicker?.value || '';
    const engine = this.state.config.ttsEngine || 'kokoro';

    if (engine === 'piper') {
      const picked = this.parsePiperOrSystemVoice(selectedValue);
      if (picked.kind === 'system') {
        if (!picked.voice) {
          if(this.dom.statusLabel) this.dom.statusLabel.textContent = 'Voice missing — click ↻ Refresh voices or wait for the list to load.';
          if (this.speaking) {
            this.advanceSentence();
            this.speakNext();
          }
          return;
        }
        if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';
        if(this.dom.statusLabel) this.dom.statusLabel.textContent = '';
        this.speakWithSystemVoice(text, picked.voice, parseFloat(this.dom.rateSlider?.value || 1));
        return;
      }

      if(this.dom.playBtn) {
        this.dom.playBtn.disabled = true;
        this.dom.playBtn.textContent = '⏳ Loading…';
      }
      const ok = await this.loadPiperModel(picked.modelKey || 'amy');
      if(this.dom.playBtn) this.dom.playBtn.disabled = false;

      if (!ok || !this.speaking) {
        if(this.dom.playBtn) this.dom.playBtn.textContent = '▶ Play';
        return;
      }
      if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';

      this.synthesizeAllPiper(this.sentenceIdx);

      const cached = this.piperAudioCache.get(this.sentenceIdx);
      if (cached && cached.blob) {
        if(this.dom.statusLabel) {
          this.dom.statusLabel.textContent = this.piperSynthCompletedCount < this.piperSynthTotalCount
            ? `Synthesizing ${this.piperSynthCompletedCount}/${this.piperSynthTotalCount}…`
            : '';
        }
        this.playFromBlob(cached.blob, cached.sampleRate, picked.modelKey || 'piper');
        return;
      }

      if(this.dom.statusLabel) this.dom.statusLabel.textContent = `Synthesizing ${this.piperSynthCompletedCount}/${this.piperSynthTotalCount}…`;
      return;
    }

    if (engine === 'kokoro' && selectedValue.startsWith('kokoro:')) {
      const voiceId = selectedValue.split(':')[1];
      if(this.dom.playBtn) {
        this.dom.playBtn.disabled = true;
        this.dom.playBtn.textContent = '⏳ Loading…';
      }
      const ok = await this.loadKokoroModel();
      if(this.dom.playBtn) this.dom.playBtn.disabled = false;
      if (!ok || !this.speaking) {
        if(this.dom.playBtn) this.dom.playBtn.textContent = '▶ Play';
        return;
      }
      if(this.dom.playBtn) this.dom.playBtn.textContent = '⏸ Pause';

      this.synthesizeAll(voiceId, this.sentenceIdx);

      const cached = this.audioCache.get(this.sentenceIdx);
      if (cached && cached.blob) {
        if(this.dom.statusLabel) {
          this.dom.statusLabel.textContent = this.synthCompletedCount < this.synthTotalCount
            ? `Synthesizing ${this.synthCompletedCount}/${this.synthTotalCount}…` : '';
        }
        this.playFromBlob(cached.blob, cached.sampleRate, voiceId);
        return;
      }

      if(this.dom.statusLabel) this.dom.statusLabel.textContent = `Synthesizing ${this.synthCompletedCount}/${this.synthTotalCount}…`;
    } else {
      this.speakWithSystemVoice(text, null, parseFloat(this.dom.rateSlider?.value || 1));
    }
  }

  advanceSentence(wordsOverride, timeMsOverride) {
    const wordsRead = Number.isFinite(wordsOverride) && wordsOverride > 0
        ? Math.floor(wordsOverride)
        : (this.currentChunkWords?.length || 1);

    let timeMs = 0;
    if (Number.isFinite(timeMsOverride) && timeMsOverride > 0) {
      timeMs = timeMsOverride;
    } else if (this.currentAudioElement) {
      timeMs = (this.currentAudioElement._lexoraDur || this.currentAudioElement.duration || 0) * 1000;
    } else if (this.sysUtteranceDurationEst) {
      timeMs = this.sysUtteranceDurationEst * 1000;
    }
    if (!isFinite(timeMs) || isNaN(timeMs)) timeMs = 0;

    if (typeof this.addStats === 'function') {
      this.addStats(wordsRead, timeMs);
    }
    this.sentenceIdx++;
    this.saveReadingProgress();
  }

  armAutoplayRetry() {
    if (this.pendingAutoplayRetry) return;
    this.pendingAutoplayRetry = true;
    if(this.dom.statusLabel) this.dom.statusLabel.textContent = 'Tap anywhere once to start audio (browser autoplay policy).';
  }

  disarmAutoplayRetry() {
    this.pendingAutoplayRetry = false;
  }

  tryAutoplayRetryOnce() {
    if (!this.pendingAutoplayRetry) return;
    this.disarmAutoplayRetry();
    try {
      if (this.currentAudioElement && typeof this.currentAudioElement.play === 'function') {
        const p = this.currentAudioElement.play();
        if (p && typeof p.catch === 'function') p.catch(err => debugLog('AudioController', 'Async operation failed', err));
        return;
      }
    } catch (err) {
      debugLog('AudioController', 'autoplay retry play() failed', err);
    }
    try { if(this.dom.playBtn) this.dom.playBtn.click(); }
    catch (err) { debugLog('AudioController', 'autoplay retry click failed', err); }
  }
}
