export function initMiniPlayerBridge({ browserAPI, playBtn, prevBtn, nextBtn }) {
  if (!browserAPI || !browserAPI.runtime || typeof browserAPI.runtime.getURL !== 'function') return;

  // Cache token for replies (play glyph sync) to the same overlay instance.
  let token = null;
  // Cache the parent origin once we see a valid message.
  let parentOrigin = null;

  function syncMiniPlayerChrome() {
    try {
      if (window.parent !== window) {
        if (!parentOrigin || !token) return;
        let playGlyph = '▶';
        const t = playBtn?.textContent || '';
        if (/⏸|Pause/.test(t)) playGlyph = '⏸';
        else if (/⏳|Loading/.test(t)) playGlyph = '⏳';
        window.parent.postMessage({ type: 'lexora-ui', playGlyph, token }, parentOrigin);
      }
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const d = event.data;
    if (!d || d.type !== 'lexora') return;
    if (typeof d.token !== 'string' || d.token.length < 8) return;
    // Lock to first-seen parent origin to avoid accepting from unexpected contexts.
    if (!parentOrigin) parentOrigin = event.origin;
    if (event.origin !== parentOrigin) return;
    token = d.token;

    if (d.action === 'play-toggle') playBtn?.click();
    else if (d.action === 'prev') prevBtn?.click();
    else if (d.action === 'next') nextBtn?.click();
  });

  if (playBtn) {
    const mo = new MutationObserver(() => syncMiniPlayerChrome());
    mo.observe(playBtn, { childList: true, subtree: true, characterData: true });
    syncMiniPlayerChrome();
  }

  return { syncMiniPlayerChrome };
}

