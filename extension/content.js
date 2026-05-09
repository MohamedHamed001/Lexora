// content.js — bootstrap: load extension/content/*.js before this file (see background.js executeScript order).
(function () {
  'use strict';

  const browserAPI =
    (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
    (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

  if (!browserAPI) {
    throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
  }

  const createOverlay = globalThis.LexoraContentCreateOverlay;
  const Highlighter = globalThis.LexoraContentHighlighter;
  const initSelection = globalThis.LexoraContentInitSelectionBar;
  const initRouter = globalThis.LexoraContentInitRouter;

  if (typeof createOverlay !== 'function' || !Highlighter || typeof initSelection !== 'function' || typeof initRouter !== 'function') {
    throw new Error('Lexora content modules not loaded (expected highlighter-alignment, content-highlighter, overlay, selection-bar, router)');
  }

  const Overlay = createOverlay(browserAPI);
  initSelection(browserAPI, Overlay);
  initRouter(browserAPI, Highlighter, Overlay);

  window.lexoraCaptureText = function () {
    return globalThis.LexoraCaptureExtractor?.extractPageContent(document, location) || null;
  };
})();
