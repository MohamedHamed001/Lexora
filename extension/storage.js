// storage.js
// Shared storage key constants and small helpers (no direct chrome.storage calls here).
(function initLexoraStorage(global) {
  const KEYS = Object.freeze({
    CURRENT_LESSON: 'currentLesson',
    CONFIG: 'lexoraConfig',
    STATS: 'lexoraStats',
    AUTO_PLAY_SELECTED_TEXT: 'autoPlaySelectedText',
    PROGRESS_INDEX: 'lexoraProgressIndex',
  });

  function fnv1a32(str) {
    // Stable, fast, sync hash for storage keys (not cryptographic).
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }

  function legacyProgressKeyForUrl(url) {
    const u = typeof url === 'string' ? url : '';
    return `progress_${u}`;
  }

  function progressKeyForUrl(url) {
    const u = typeof url === 'string' ? url : '';
    const h = fnv1a32(u).toString(36);
    return `progress_${h}`;
  }

  global.LexoraStorage = Object.freeze({
    KEYS,
    legacyProgressKeyForUrl,
    progressKeyForUrl,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);

