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

  global.LexoraProtocol = Object.freeze({
    ACTIONS,
    isObject,
    getAction,
    isKnownAction,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);

