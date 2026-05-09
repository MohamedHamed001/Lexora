import { debugLog } from './messaging.js';

export function initMiniPlayerBridge({ browserAPI, playBtn, prevBtn, nextBtn }) {
  if (!browserAPI || !browserAPI.runtime || typeof browserAPI.runtime.getURL !== 'function') return;

  /** @type {MessagePort | null} */
  let controlPort = null;
  let token = null;

  function syncMiniPlayerChrome() {
    try {
      if (window.parent === window) return;
      if (!controlPort || !token) return;
      let playGlyph = '▶';
      const t = playBtn?.textContent || '';
      if (/⏸|Pause/.test(t)) playGlyph = '⏸';
      else if (/⏳|Loading/.test(t)) playGlyph = '⏳';
      controlPort.postMessage({ type: 'lexora-ui', playGlyph, token });
    } catch (err) {
      debugLog('MiniPlayer', 'syncMiniPlayerChrome postMessage failed', err);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const d = event.data;
    if (!d || d.type !== 'lexora-port-handshake') return;
    if (!event.ports || !event.ports[0]) return;
    if (typeof d.token !== 'string' || d.token.length < 8) return;

    const expectedToken = d.token;
    const port = event.ports[0];
    try {
      port.start();
    } catch (_) { /* already started */ }

    if (controlPort) {
      try {
        controlPort.close();
      } catch (_) { /* ignore */ }
    }
    controlPort = port;
    token = expectedToken;

    port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.type !== 'lexora') return;
      if (msg.token !== expectedToken) return;
      if (msg.action === 'play-toggle') playBtn?.click();
      else if (msg.action === 'prev') prevBtn?.click();
      else if (msg.action === 'next') nextBtn?.click();
    };
  });

  if (playBtn) {
    const mo = new MutationObserver(() => syncMiniPlayerChrome());
    mo.observe(playBtn, { childList: true, subtree: true, characterData: true });
    syncMiniPlayerChrome();
  }

  return { syncMiniPlayerChrome };
}
