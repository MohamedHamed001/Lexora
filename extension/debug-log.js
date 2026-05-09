/**
 * debug-log.js
 * Structured logging for service workers and other non-module contexts.
 */



function debugLog(area, msg, error = null) {
  const prefix = `[Lexora:${area}]`;
  if (error) {
    console.error(`${prefix} ${msg}`, error);
  } else if (msg instanceof Error) {
    console.error(`${prefix} Error:`, msg);
  } else {
    // Basic console.debug/log based on presence of 'error' keywords
    const isErr = String(msg).toLowerCase().includes('error') || String(area).toLowerCase().includes('error');
    if (isErr) console.warn(`${prefix} ${msg}`);
    else console.log(`${prefix} ${msg}`);
  }
}

// For safe messaging inside background script
async function sendMessageSafe(api, tabId, msg, options = {}) {
  try {
    if (!api || !api.tabs || !api.tabs.sendMessage) return { ok: false, error: 'API missing' };
    const response = await api.tabs.sendMessage(tabId, msg, options);
    return { ok: true, data: response };
  } catch (err) {
    return { ok: false, error: err.message || err.toString() };
  }
}

async function sendRuntimeMessageSafe(api, msg) {
  try {
    if (!api || !api.runtime || !api.runtime.sendMessage) return { ok: false, error: 'API missing' };
    const response = await api.runtime.sendMessage(msg);
    return { ok: true, data: response };
  } catch (err) {
    return { ok: false, error: err.message || err.toString() };
  }
}

// Ensure these functions are globally available
globalThis.debugLog = debugLog;
globalThis.sendMessageSafe = sendMessageSafe;
globalThis.sendRuntimeMessageSafe = sendRuntimeMessageSafe;
