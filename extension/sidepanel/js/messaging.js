/**
 * messaging.js
 *
 * Sidepanel-side ES module facade over the safe-messaging helpers defined in
 * extension/debug-log.js. The implementations live in a single file so the
 * background service worker (`importScripts`) and the sidepanel modules
 * (`import`) share one source of truth and cannot drift.
 */

// Side-effect import: attaches `debugLog`, `sendMessageSafe`, and
// `sendRuntimeMessageSafe` to `globalThis`. Safe to import multiple times —
// reassigning the same functions is a no-op.
import '../../debug-log.js';

export function debugLog(area, msg, error = null) {
  return globalThis.debugLog(area, msg, error);
}

export function sendMessageSafe(api, tabId, msg, options = {}) {
  return globalThis.sendMessageSafe(api, tabId, msg, options);
}

export function sendRuntimeMessageSafe(api, msg) {
  return globalThis.sendRuntimeMessageSafe(api, msg);
}
