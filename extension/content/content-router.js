// Runtime message routing for overlay + highlighter. Call LexoraContentInitRouter(browserAPI, Highlighter, Overlay).
(function initLexoraContentRouter(global) {
  global.LexoraContentInitRouter = function LexoraContentInitRouter(browserAPI, Highlighter, Overlay) {
    browserAPI.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'captureFinished') {
        // Handled elsewhere if needed
      } else if (msg.action === 'toggleOverlay') {
        Overlay.toggleOverlay();
      } else if (msg.action === 'setHighlightAnchor') {
        Highlighter.setHighlightAnchor(msg.text);
      } else if (msg.action === 'highlightWord') {
        Highlighter.highlightWord(msg.chunkText, msg.wordIndex, 0, msg.playbackGen);
      } else if (msg.action === 'clearHighlight') {
        Highlighter.clearHighlight(msg.fullReset, msg.playbackGen);
      }
    });

    let _url = location.href;
    const navObserver = new MutationObserver(() => {
      if (location.href !== _url) {
        _url = location.href;
      }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
