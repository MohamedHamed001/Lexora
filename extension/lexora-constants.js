// Shared numeric thresholds (service worker + injected page scripts). Keep in sync across guards & extractor.
(function initLexoraConstants(global) {
  global.LexoraConstants = Object.freeze({
    /** Minimum lesson/capture content length (background “best frame”, guards, extractor gate). */
    MIN_CAPTURE_CONTENT_CHARS: 80,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
