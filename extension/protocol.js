// protocol.js
// Shared constants + lightweight guards for cross-context messaging.
// Loaded via `importScripts()` in the service worker and via ESM import in sidepanel modules.
(function initLexoraProtocol(global) {
  const ACTIONS = Object.freeze({
    PROXY_FETCH: 'proxyFetch',
    TRIGGER_DEEP_CAPTURE: 'triggerDeepCapture',
    PROBE_CAPTURABLE: 'probeCapturable',
    HIGHLIGHT_WORD: 'highlightWord',
    CLEAR_HIGHLIGHT: 'clearHighlight',
    CAPTURE_TEXT: 'captureText',
    ASK_AI_ABOUT_TEXT: 'askAiAboutText',
    SET_HIGHLIGHT_ANCHOR: 'setHighlightAnchor',
    CAPTURE_FINISHED: 'captureFinished',
    TOGGLE_OVERLAY: 'toggleOverlay',
    AUTO_CAPTURE_SAVE: 'autoCaptureSave',
  });

  function isObject(x) {
    return !!x && typeof x === 'object';
  }

  function getAction(msg) {
    return isObject(msg) && typeof msg.action === 'string' ? msg.action : null;
  }

  function isKnownAction(action) {
    return Object.values(ACTIONS).includes(action);
  }

  function isProxyFetchRequest(msg) {
    return (
      isObject(msg) &&
      msg.action === ACTIONS.PROXY_FETCH &&
      typeof msg.url === 'string' &&
      (!msg.method || typeof msg.method === 'string') &&
      (!msg.headers || isObject(msg.headers))
    );
  }

  function isTextSelectionRequest(msg) {
    return (
      isObject(msg) &&
      (msg.action === ACTIONS.CAPTURE_TEXT || msg.action === ACTIONS.ASK_AI_ABOUT_TEXT) &&
      typeof msg.text === 'string' &&
      msg.text.trim().length > 0
    );
  }

  function isHighlightWordRequest(msg) {
    return (
      isObject(msg) &&
      msg.action === ACTIONS.HIGHLIGHT_WORD &&
      typeof msg.chunkText === 'string' &&
      Number.isInteger(msg.wordIndex) &&
      msg.wordIndex >= 0
    );
  }

  function isClearHighlightRequest(msg) {
    return isObject(msg) && msg.action === ACTIONS.CLEAR_HIGHLIGHT;
  }

  function isAutoCaptureSaveRequest(msg) {
    return isObject(msg) && msg.action === ACTIONS.AUTO_CAPTURE_SAVE && msg.data != null;
  }

  global.LexoraProtocol = Object.freeze({
    ACTIONS,
    isObject,
    getAction,
    isKnownAction,
    isProxyFetchRequest,
    isTextSelectionRequest,
    isHighlightWordRequest,
    isClearHighlightRequest,
    isAutoCaptureSaveRequest,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
