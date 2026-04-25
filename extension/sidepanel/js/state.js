// ── Global Shared State ───────────────────────────────────────────────────

export const state = {
  currentLesson: null,
  config: {
    url: 'http://127.0.0.1:1234/v1/chat/completions',
    model: 'local-model',
    key: '',
    ttsEngine: 'kokoro',
    kokoroDtype: 'q8',
  },
  chatHistory: [],
  
  // TTS State
  speaking: false,
  isPaused: false,
  sentences: [],
  sentenceIdx: 0,
  
  // Audio state
  currentAudioElement: null,
  
  // For web speech fallback
  sysUtteranceDurationEst: 0,
  sysUtteranceT0: 0,
  sysUtteranceHighlight: false,
  currentChunkText: null,
  currentChunkWords: [],
  lastHighlightedWord: -1,
  
  // Worker states
  piperWorkers: [],
  piperAudioCache: new Map(),
  piperSynthCompletedCount: 0,
  piperSynthTotalCount: 0,
  
  kokoroWorkers: [],
  audioCache: new Map(),
  synthCompletedCount: 0,
  synthTotalCount: 0,
  
  // Google Voice
  googleVoice: null,
  
  // Browser Extension API abstraction
  browserAPI: (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
              (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null),
              
  // Study Statistics
  stats: {
    session: { wordsRead: 0, timeListened: 0 },
    allTime: { wordsRead: 0, timeListened: 0 }
  }
};

if (!state.browserAPI) {
  console.warn('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}
