// ── DOM Elements ──────────────────────────────────────────────────────────

export const dom = {
  // Capture
  captureBtn: document.getElementById('capture-btn'),
  captureStatus: document.getElementById('capture-status'),
  
  // Headers
  urlEl: document.getElementById('lesson-url'),
  titleEl: document.getElementById('lesson-title'),
  lessonHeader: document.getElementById('lesson-header'),
  
  // Content Tab
  lessonText: document.getElementById('lesson-text'),
  
  // Chat Tab
  chatInput: document.getElementById('chat-input'),
  chatMessages: document.getElementById('chat-messages'),
  
  // Audio Tab
  playBtn: document.getElementById('play-btn'),
  prevBtn: document.getElementById('prev-btn'),
  nextBtn: document.getElementById('next-btn'),
  statusLabel: document.getElementById('status-label'),
  seekBar: document.getElementById('seek-bar'),
  rateSlider: document.getElementById('rate-slider'),
  rateLabel: document.getElementById('rate-label'),
  ttsEngineSelect: document.getElementById('tts-engine'),
  voicePicker: document.getElementById('voice-picker'),
  
  // Kokoro specific
  kokoroDtypeRow: document.getElementById('kokoro-dtype-row'),
  kokoroDtypeSelect: document.getElementById('kokoro-dtype'),
  downloadProgress: document.getElementById('download-progress'),
  downloadBar: document.getElementById('download-bar'),
  downloadText: document.getElementById('download-text'),
  
  // Export Tab
  exportInfo: document.getElementById('export-info'),
  exportPdfBtn: document.getElementById('export-pdf'),
  
  // Settings Tab
  settingUrl: document.getElementById('setting-url'),
  settingModel: document.getElementById('setting-model'),
  settingKey: document.getElementById('setting-key'),
  settingTheme: document.getElementById('setting-theme'),
  settingAutoCapture: document.getElementById('setting-autocapture'),
  statSessionWords: document.getElementById('stat-session-words'),
  statSessionTime: document.getElementById('stat-session-time'),
  statAllTimeWords: document.getElementById('stat-alltime-words'),
  statAllTimeTime: document.getElementById('stat-alltime-time'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  settingsStatus: document.getElementById('settings-status'),
  
  // Main container
  contentContainer: document.getElementById('content-container')
};
