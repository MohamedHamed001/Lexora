import { state } from './state.js';
import { dom } from './dom.js';
import { applyLesson } from './ui.js';

export function initSettings() {
  if (!state.browserAPI) return;
  const K = (globalThis.LexoraStorage && LexoraStorage.KEYS) || {
    CURRENT_LESSON: 'currentLesson',
    CONFIG: 'lexoraConfig',
    STATS: 'lexoraStats',
    AUTO_PLAY_SELECTED_TEXT: 'autoPlaySelectedText',
  };

  function safeUrlToOriginPattern(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.host}/*`;
    } catch (_) {
      return null;
    }
  }

  function isLocalEndpoint(url) {
    try {
      const u = new URL(url);
      return (
        u.hostname === '127.0.0.1' ||
        u.hostname === 'localhost' ||
        u.hostname === '::1'
      );
    } catch (_) {
      return true;
    }
  }

  async function ensureOptionalPermissionsForConfig(nextConfig) {
    const api = state.browserAPI;
    if (!api.permissions || typeof api.permissions.request !== 'function') return true;

    async function activeTabOriginPattern() {
      if (!api.tabs || typeof api.tabs.query !== 'function') return null;
      try {
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        const url = tabs && tabs[0] && tabs[0].url ? tabs[0].url : '';
        return safeUrlToOriginPattern(url);
      } catch (_) {
        return null;
      }
    }

    // Auto-capture needs webNavigation + host permission for the *current origin*.
    // We intentionally avoid requesting `<all_urls>` as part of enabling this feature.
    if (nextConfig?.autoCapture) {
      const originPat = await activeTabOriginPattern();
      if (!originPat) return false;
      try {
        const ok = await api.permissions.request({
          permissions: ['webNavigation'],
          origins: [originPat],
        });
        if (!ok) return false;
      } catch (_) {
        return false;
      }
    }

    // Remote endpoint access may require host permissions (localhost doesn't).
    if (nextConfig?.url && !isLocalEndpoint(nextConfig.url)) {
      const pat = safeUrlToOriginPattern(nextConfig.url);
      // Do not escalate to `<all_urls>` on parse failures. Require a valid http(s) URL.
      if (!pat) return false;
      const origins = [pat];
      try {
        const ok = await api.permissions.request({ origins });
        if (!ok) return false;
      } catch (_) {
        return false;
      }
    }

    return true;
  }

  state.browserAPI.storage.local.get([K.CURRENT_LESSON, K.CONFIG, K.STATS, K.AUTO_PLAY_SELECTED_TEXT], res => {
    if (res[K.CURRENT_LESSON]) {
      state.currentLesson = res[K.CURRENT_LESSON];
      applyLesson(state.currentLesson);
    }
    if (res[K.CONFIG]) {
      // Keep object identity stable (sidepanel.js holds a reference).
      Object.assign(state.config, res[K.CONFIG]);
      // Cloud TTS feature was removed — ensure we don't keep stale secrets.
      delete state.config.ttsKey;
      delete state.config.aiCleanupOnCapture;
    }
    if (state.config.kokoroDtype !== 'q4' && state.config.kokoroDtype !== 'q8') state.config.kokoroDtype = 'q8';
    if (dom.settingUrl) dom.settingUrl.value = state.config.url || '';
    if (dom.settingModel) dom.settingModel.value = state.config.model || '';
    if (dom.settingKey) dom.settingKey.value = state.config.key || '';
    if (dom.settingTheme) {
      dom.settingTheme.checked = state.config.theme === 'light';
      if (state.config.theme === 'light') {
        document.body.classList.add('theme-light');
      } else {
        document.body.classList.remove('theme-light');
      }
    }
    if (dom.settingAutoCapture) {
      dom.settingAutoCapture.checked = !!state.config.autoCapture;
    }
    
    // Load stats
    if (res[K.STATS]?.allTime) {
      state.stats.allTime = { ...state.stats.allTime, ...res[K.STATS].allTime };
    }
    updateStatsUI();

    if (dom.ttsEngineSelect) dom.ttsEngineSelect.value = state.config.ttsEngine || 'kokoro';
    if (dom.kokoroDtypeSelect) dom.kokoroDtypeSelect.value = state.config.kokoroDtype || 'q8';
    
    if (window.lexoraAudio) window.lexoraAudio.updateKokoroDtypeRowVisibility();
    if (window.lexoraAudio) window.lexoraAudio.initVoice();

    if (res[K.AUTO_PLAY_SELECTED_TEXT] && state.currentLesson && state.currentLesson.title === 'Selected Text') {
      // Clear the one-shot flag.
      state.browserAPI.storage.local.set({ [K.AUTO_PLAY_SELECTED_TEXT]: false });

      // Switch to Audio tab and start playback.
      const audioTab = document.querySelector('.tab[data-tab="audio"]');
      if (audioTab) audioTab.click();
      if (window.lexoraAudio && typeof window.lexoraAudio.startPlayback === 'function') {
        window.lexoraAudio.startPlayback();
      }
    }
  });

  // If the sidepanel is already open, Selected Text "Read" updates storage but doesn't reload the panel.
  // Listen for the one-shot flag + lesson update and auto-start playback.
  state.browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[K.STATS]?.newValue?.allTime) {
      state.stats.allTime = { ...state.stats.allTime, ...changes[K.STATS].newValue.allTime };
      updateStatsUI();
    }
    const nextFlag = changes[K.AUTO_PLAY_SELECTED_TEXT]?.newValue;
    const nextLesson = changes[K.CURRENT_LESSON]?.newValue;
    if (!nextFlag) return;
    if (!nextLesson || nextLesson.title !== 'Selected Text' || !nextLesson.content) return;

    state.currentLesson = nextLesson;
    applyLesson(state.currentLesson);
    state.browserAPI.storage.local.set({ [K.AUTO_PLAY_SELECTED_TEXT]: false });

    const audioTab = document.querySelector('.tab[data-tab="audio"]');
    if (audioTab) audioTab.click();
    if (window.lexoraAudio && typeof window.lexoraAudio.startPlayback === 'function') {
      window.lexoraAudio.startPlayback();
    }
  });

  if (dom.saveSettingsBtn) {
    dom.saveSettingsBtn.addEventListener('click', () => {
      state.config.url = dom.settingUrl.value.trim();
      state.config.model = dom.settingModel.value.trim();
      state.config.key = dom.settingKey.value.trim();
      state.config.theme = dom.settingTheme.checked ? 'light' : 'dark';
      state.config.autoCapture = dom.settingAutoCapture ? dom.settingAutoCapture.checked : false;
      
      if (state.config.theme === 'light') {
        document.body.classList.add('theme-light');
      } else {
        document.body.classList.remove('theme-light');
      }
      
      (async () => {
        const ok = await ensureOptionalPermissionsForConfig(state.config);
        if (!ok) {
          // Keep config saved locally even if optional perms were denied; features will degrade gracefully.
          if (dom.settingsStatus) {
            dom.settingsStatus.textContent = '⚠️ Saved, but optional permissions were denied.';
            setTimeout(() => { dom.settingsStatus.textContent = ''; }, 3500);
          }
        }

        state.browserAPI.storage.local.set({ lexoraConfig: state.config }, () => {
          if (dom.settingsStatus) {
            dom.settingsStatus.textContent = ok ? '✅ Config Saved' : '✅ Config Saved (limited)';
            if (window.lexoraAudio) window.lexoraAudio.initVoice();
            setTimeout(() => { dom.settingsStatus.textContent = ''; }, 2000);
          }
        });
      })();
    });
  }

  if (dom.ttsEngineSelect) {
    dom.ttsEngineSelect.addEventListener('change', () => {
      const nextEngine = dom.ttsEngineSelect.value === 'piper' ? 'piper' : 'kokoro';
      state.config.ttsEngine = nextEngine;
      if (window.lexoraAudio) window.lexoraAudio.cancelAudio(true);
      if (window.lexoraAudio) window.lexoraAudio.showDownloadProgress(false);
      
      // Note: KOKORO_VOICE_META will be imported or managed in audio.js
      if (window.lexoraAudio) window.lexoraAudio.updateKokoroDtypeRowVisibility();
      state.browserAPI.storage.local.set({ lexoraConfig: state.config });
      if (window.lexoraAudio) window.lexoraAudio.initVoice(); // re-init voice when engine changes
    });
  }

  if (dom.kokoroDtypeSelect) {
    dom.kokoroDtypeSelect.addEventListener('change', () => {
      const next = dom.kokoroDtypeSelect.value === 'q4' ? 'q4' : 'q8';
      if (next === state.config.kokoroDtype) return;
      state.config.kokoroDtype = next;
      if (window.lexoraAudio) window.lexoraAudio.disposeKokoroWorkers();
      state.browserAPI.storage.local.set({ lexoraConfig: state.config });
    });
  }
}

export function updateStatsUI() {
  if (dom.statSessionWords) dom.statSessionWords.textContent = state.stats.session.wordsRead.toLocaleString();
  if (dom.statSessionTime) dom.statSessionTime.textContent = formatTime(state.stats.session.timeListened);
  if (dom.statAllTimeWords) dom.statAllTimeWords.textContent = state.stats.allTime.wordsRead.toLocaleString();
  if (dom.statAllTimeTime) dom.statAllTimeTime.textContent = formatTime(state.stats.allTime.timeListened);
}

export function addStats(words, timeMs) {
  const w = Number.isFinite(words) ? Math.max(0, Math.floor(words)) : 0;
  const t = Number.isFinite(timeMs) ? Math.max(0, Math.floor(timeMs)) : 0;

  state.stats.session.wordsRead += w;
  state.stats.session.timeListened += t;
  state.stats.allTime.wordsRead += w;
  state.stats.allTime.timeListened += t;
  
  // Save allTime stats
  try {
    state.browserAPI?.storage?.local?.set?.({
      lexoraStats: { allTime: state.stats.allTime }
    });
  } catch (_) {}
  updateStatsUI();
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
