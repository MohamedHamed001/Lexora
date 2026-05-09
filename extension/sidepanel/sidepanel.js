// sidepanel.js — Lexora Composition Root
import { state } from './js/state.js';
import { dom, assertSidepanelDom } from './js/dom.js';

assertSidepanelDom();
import { AudioController } from './js/audio-controller.js';
import { initUI } from './js/ui.js';
import { initChat } from './js/chat.js';
import { initExport } from './js/export.js';
import { initMiniPlayerBridge } from './js/miniplayer-bridge.js';
import { initSettings, addStats } from './js/settings.js';



// ── Composition Root ──────────────────────────────────────
const audio = new AudioController({ state, dom, browserAPI: state.browserAPI, addStats });

initUI({ audio });
initChat();
initExport();
initSettings({ audio });
initMiniPlayerBridge({ browserAPI: state.browserAPI, playBtn: dom.playBtn, prevBtn: dom.prevBtn, nextBtn: dom.nextBtn });

// ── Keyboard Shortcuts ──────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName.toLowerCase();
  const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (isEditable) return; // Don't intercept when user is typing

  if (e.code === 'Space') {
    e.preventDefault();
    dom.playBtn?.click();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    dom.prevBtn?.click();
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    dom.nextBtn?.click();
  }
});
