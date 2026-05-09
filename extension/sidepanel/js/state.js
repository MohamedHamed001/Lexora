// ── Global Shared State ───────────────────────────────────────────────────
import '../../protocol.js';
import '../../storage.js';

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
