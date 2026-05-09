import { state } from './state.js';
import { dom } from './dom.js';
import { applyLesson } from './ui.js';
import { debugLog } from './messaging.js';

let audioCtrl = null;

// Sensitive fields that must never leak into `storage.local` unless the user
// has explicitly opted in to persisting them (rememberKey).
const SENSITIVE_KEYS = ['key', 'ttsKey'];

/**
 * Produce a sanitized copy of `config` safe for `storage.local`. When
 * `rememberKey` is false, all sensitive credentials are stripped — protecting
 * users who chose session-only secrets from incidental writes (e.g. toggling
 * the TTS engine) re-persisting the in-memory key.
 *
 * Pure function: exported for unit tests.
 */
export function buildPersistedConfig(config, rememberKey) {
  const out = { ...(config || {}) };
  if (!rememberKey) {
    for (const k of SENSITIVE_KEYS) delete out[k];
  }
  return out;
}

export function initSettings({ audio }) {
  audioCtrl = audio;
  if (!state.browserAPI) return;
  const K = (globalThis.LexoraStorage && LexoraStorage.KEYS) || {
    CURRENT_LESSON: 'currentLesson',
    CONFIG: 'lexoraConfig',
    STATS: 'lexoraStats',
    AUTO_PLAY_SELECTED_TEXT: 'autoPlaySelectedText',
  };

  // Closure-scoped flag tracking the user's "remember key" preference. Updated
  // on initial load + Save; consulted by every config persistence path.
  let rememberKey = false;

  function persistConfig() {
    const payload = buildPersistedConfig(state.config, rememberKey);
    state.browserAPI.storage.local.set({ [K.CONFIG]: payload });
  }

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
      } catch (err) {
        debugLog('Settings', 'tabs.query for active origin failed', err);
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
      } catch (err) {
        debugLog('Settings', 'webNavigation permission request failed', err);
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
      } catch (err) {
        debugLog('Settings', 'host permission request failed', err);
        return false;
      }
    }

    return true;
  }

  const getSessionKey = () => new Promise(resolve => {
    if (state.browserAPI.storage.session) {
      state.browserAPI.storage.session.get(['lexoraConfigKey'], res => resolve(res?.lexoraConfigKey));
    } else {
      resolve(null);
    }
  });

  const saveSessionKey = (key) => new Promise(resolve => {
    if (state.browserAPI.storage.session) {
      if (key) state.browserAPI.storage.session.set({ lexoraConfigKey: key }, resolve);
      else state.browserAPI.storage.session.remove(['lexoraConfigKey'], resolve);
    } else {
      resolve();
    }
  });

  getSessionKey().then(sessionKey => {
    state.browserAPI.storage.local.get([K.CURRENT_LESSON, K.CONFIG, K.STATS, K.AUTO_PLAY_SELECTED_TEXT], res => {
      if (res[K.CURRENT_LESSON]) {
        state.currentLesson = res[K.CURRENT_LESSON];
        applyLesson(state.currentLesson);
      }
      let rememberedKey = false;
      if (res[K.CONFIG]) {
        // Keep object identity stable (sidepanel.js holds a reference).
        Object.assign(state.config, res[K.CONFIG]);
        // Cloud TTS feature was removed — ensure we don't keep stale secrets.
        delete state.config.ttsKey;
        delete state.config.aiCleanupOnCapture;
        rememberedKey = !!state.config.key;
      }
      rememberKey = rememberedKey;

      if (sessionKey && !rememberedKey) {
        state.config.key = sessionKey;
      }

      if (state.config.kokoroDtype !== 'q4' && state.config.kokoroDtype !== 'q8') state.config.kokoroDtype = 'q8';
      if (dom.settingUrl) dom.settingUrl.value = state.config.url || '';
      if (dom.settingModel) dom.settingModel.value = state.config.model || '';
      if (dom.settingKey) dom.settingKey.value = state.config.key || '';
      if (dom.settingRememberKey) dom.settingRememberKey.checked = rememberedKey;
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
    
    if (audioCtrl) audioCtrl.updateKokoroDtypeRowVisibility();
    if (audioCtrl) audioCtrl.initVoice();

    if (res[K.AUTO_PLAY_SELECTED_TEXT] && state.currentLesson && state.currentLesson.title === 'Selected Text') {
      // Clear the one-shot flag.
      state.browserAPI.storage.local.set({ [K.AUTO_PLAY_SELECTED_TEXT]: false });

      // Switch to Audio tab and start playback.
      const audioTab = document.querySelector('.tab[data-tab="audio"]');
      if (audioTab) audioTab.click();
      if (audioCtrl && typeof audioCtrl.startPlayback === 'function') {
        audioCtrl.startPlayback();
      }
    }
  });
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
    if (audioCtrl && typeof audioCtrl.startPlayback === 'function') {
      audioCtrl.startPlayback();
    }
  });

  if (dom.saveSettingsBtn) {
    dom.saveSettingsBtn.addEventListener('click', () => {
      state.config.url = dom.settingUrl.value.trim();
      state.config.model = dom.settingModel.value.trim();
      const userKey = dom.settingKey.value.trim();
      rememberKey = dom.settingRememberKey ? dom.settingRememberKey.checked : false;
      state.config.key = userKey;

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

        await saveSessionKey(rememberKey ? null : userKey);

        const payload = buildPersistedConfig(state.config, rememberKey);
        state.browserAPI.storage.local.set({ [K.CONFIG]: payload }, () => {
          if (dom.settingsStatus) {
            dom.settingsStatus.textContent = ok ? '✅ Config Saved' : '✅ Config Saved (limited)';
            if (audioCtrl) audioCtrl.initVoice();
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
      if (audioCtrl) audioCtrl.cancelAudio(true);
      if (audioCtrl) audioCtrl.showDownloadProgress(false);

      if (audioCtrl) audioCtrl.updateKokoroDtypeRowVisibility();
      persistConfig();
      if (audioCtrl) audioCtrl.initVoice(); // re-init voice when engine changes
    });
  }

  if (dom.kokoroDtypeSelect) {
    dom.kokoroDtypeSelect.addEventListener('change', () => {
      const next = dom.kokoroDtypeSelect.value === 'q4' ? 'q4' : 'q8';
      if (next === state.config.kokoroDtype) return;
      state.config.kokoroDtype = next;
      if (audioCtrl) audioCtrl.disposeKokoroWorkers();
      persistConfig();
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
  
  // Save allTime stats (best effort; UI is updated unconditionally below)
  try {
    state.browserAPI?.storage?.local?.set?.({
      lexoraStats: { allTime: state.stats.allTime }
    });
  } catch (err) {
    debugLog('Stats', 'Persisting allTime stats failed', err);
  }
  updateStatsUI();
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
