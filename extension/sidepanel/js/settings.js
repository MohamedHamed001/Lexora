import { state } from './state.js';
import { dom } from './dom.js';
import { applyLesson } from './ui.js';

export function initSettings() {
  if (!state.browserAPI) return;

  state.browserAPI.storage.local.get(['currentLesson', 'lexoraConfig', 'autoPlaySelectedText'], res => {
    if (res.currentLesson) {
      state.currentLesson = res.currentLesson;
      applyLesson(state.currentLesson);
    }
    if (res.lexoraConfig) {
      // Keep object identity stable (sidepanel.js holds a reference).
      Object.assign(state.config, res.lexoraConfig);
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
    if (res.lexoraStats) {
      state.stats.allTime = { ...state.stats.allTime, ...res.lexoraStats.allTime };
    }
    updateStatsUI();

    if (dom.ttsEngineSelect) dom.ttsEngineSelect.value = state.config.ttsEngine || 'kokoro';
    if (dom.kokoroDtypeSelect) dom.kokoroDtypeSelect.value = state.config.kokoroDtype || 'q8';
    
    if (window.lexoraAudio) window.lexoraAudio.updateKokoroDtypeRowVisibility();
    if (window.lexoraAudio) window.lexoraAudio.initVoice();

    if (res.autoPlaySelectedText && state.currentLesson && state.currentLesson.title === 'Selected Text') {
      // Clear the one-shot flag.
      state.browserAPI.storage.local.set({ autoPlaySelectedText: false });

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
    const nextFlag = changes.autoPlaySelectedText?.newValue;
    const nextLesson = changes.currentLesson?.newValue;
    if (!nextFlag) return;
    if (!nextLesson || nextLesson.title !== 'Selected Text' || !nextLesson.content) return;

    state.currentLesson = nextLesson;
    applyLesson(state.currentLesson);
    state.browserAPI.storage.local.set({ autoPlaySelectedText: false });

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
      
      state.browserAPI.storage.local.set({ lexoraConfig: state.config }, () => {
        if (dom.settingsStatus) {
          dom.settingsStatus.textContent = '✅ Config Saved';
          if (window.lexoraAudio) window.lexoraAudio.initVoice();
          setTimeout(() => { dom.settingsStatus.textContent = ''; }, 2000);
        }
      });
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
  state.stats.session.wordsRead += words;
  state.stats.session.timeListened += timeMs;
  state.stats.allTime.wordsRead += words;
  state.stats.allTime.timeListened += timeMs;
  
  // Save allTime stats
  state.browserAPI.storage.local.set({ 
    lexoraStats: { allTime: state.stats.allTime } 
  });
  updateStatsUI();
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
