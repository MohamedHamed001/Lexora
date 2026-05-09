/**
 * Cross-context message validation helpers (service worker via importScripts).
 * Keeps background.js readable and unit-testable without loading the full SW.
 */
(function initLexoraMessageGuards(global) {
  const MAX_SELECTION_TEXT_CHARS = 500_000;
  const MAX_LESSON_CONTENT_CHARS = 2_000_000;
  const MAX_LESSON_TITLE_CHARS = 2_000;
  const MAX_LESSON_URL_CHARS = 8_192;
  const MIN_CAPTURE_CONTENT_CHARS = 80;

  function isTrustedSelectionSender(sender, runtimeId) {
    if (!sender) return false;
    if (runtimeId && sender.id && sender.id !== runtimeId) return false;
    if (!Number.isInteger(sender.tab?.id)) return false;
    return true;
  }

  function clampSelectionText(text) {
    if (typeof text !== 'string') return '';
    const t = text.trim();
    if (t.length <= MAX_SELECTION_TEXT_CHARS) return t;
    return t.slice(0, MAX_SELECTION_TEXT_CHARS);
  }

  /**
   * Normalize auto-capture / message-supplied lesson objects. Returns null if unusable.
   */
  function normalizeAutoCaptureLesson(data) {
    if (!data || typeof data !== 'object') return null;
    let content = typeof data.content === 'string' ? data.content : '';
    if (content.length < MIN_CAPTURE_CONTENT_CHARS) return null;
    if (content.length > MAX_LESSON_CONTENT_CHARS) {
      content = content.slice(0, MAX_LESSON_CONTENT_CHARS);
    }
    let title = typeof data.title === 'string' ? data.title : 'Captured Page';
    if (title.length > MAX_LESSON_TITLE_CHARS) title = title.slice(0, MAX_LESSON_TITLE_CHARS);
    let url = typeof data.url === 'string' ? data.url : '';
    if (url.length > MAX_LESSON_URL_CHARS) url = url.slice(0, MAX_LESSON_URL_CHARS);
    return { title, content, url };
  }

  global.LexoraMessageGuards = Object.freeze({
    MAX_SELECTION_TEXT_CHARS,
    MAX_LESSON_CONTENT_CHARS,
    MIN_CAPTURE_CONTENT_CHARS,
    isTrustedSelectionSender,
    clampSelectionText,
    normalizeAutoCaptureLesson,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
