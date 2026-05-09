// background.js
// Chrome MV3 runs background.js in a service worker (importScripts available).
// Firefox MV3 loads background.scripts in order as an event page (no importScripts).
// In Firefox, the helpers below are already attached to globalThis by the
// preceding manifest entries, so we only call importScripts when it exists.
if (typeof importScripts === 'function') {
  importScripts('debug-log.js');
  importScripts('protocol.js');
  importScripts('message-guards.js');
  importScripts('storage.js');
  importScripts('capture-extractor.js');
  importScripts('capture-clean.js');
}

const browserAPI =
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
  (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

if (!browserAPI) {
  throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}

// Pull action constants from the shared protocol module so we never hard-code
// strings here. Falls back to literal strings only if protocol.js failed to load.
const ACTIONS = (globalThis.LexoraProtocol && LexoraProtocol.ACTIONS) || {
  PROXY_FETCH: 'proxyFetch',
  HIGHLIGHT_WORD: 'highlightWord',
  CLEAR_HIGHLIGHT: 'clearHighlight',
  CAPTURE_TEXT: 'captureText',
  ASK_AI_ABOUT_TEXT: 'askAiAboutText',
  TRIGGER_DEEP_CAPTURE: 'triggerDeepCapture',
  PROBE_CAPTURABLE: 'probeCapturable',
  AUTO_CAPTURE_SAVE: 'autoCaptureSave',
  SET_HIGHLIGHT_ANCHOR: 'setHighlightAnchor',
  CAPTURE_FINISHED: 'captureFinished',
  TOGGLE_OVERLAY: 'toggleOverlay',
};

// ── Config cache (avoid async storage lookups per request) ──────────────────
const EXTENSION_ORIGIN = (() => {
  try {
    return new URL(browserAPI.runtime.getURL('')).origin;
  } catch (_) {
    return null;
  }
})();

let _lexoraConfigCache = null;
const STORAGE_KEYS = (globalThis.LexoraStorage && LexoraStorage.KEYS) || { CONFIG: 'lexoraConfig' };
browserAPI.storage?.local?.get?.([STORAGE_KEYS.CONFIG], (res) => {
  if (res && res[STORAGE_KEYS.CONFIG]) _lexoraConfigCache = res[STORAGE_KEYS.CONFIG];
});
browserAPI.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.CONFIG]) _lexoraConfigCache = changes[STORAGE_KEYS.CONFIG].newValue || null;
});

function isExtensionSender(sender) {
  // Sidepanel (extension page) should have sender.url set to chrome-extension://.../...
  // Content scripts typically do not.
  if (!sender) return false;
  if (sender.id && browserAPI.runtime?.id && sender.id !== browserAPI.runtime.id) return false;
  if (!EXTENSION_ORIGIN) return false;
  if (typeof sender.url !== 'string') return false;
  try {
    return new URL(sender.url).origin === EXTENSION_ORIGIN;
  } catch (_) {
    return false;
  }
}

function getConfiguredChatEndpointUrl() {
  const url = _lexoraConfigCache && typeof _lexoraConfigCache.url === 'string' ? _lexoraConfigCache.url : null;
  if (!url) return null;
  try {
    return new URL(url);
  } catch (_) {
    return null;
  }
}

function isAllowedProxyUrl(u) {
  // Allow only the configured endpoint origin by default.
  const configured = getConfiguredChatEndpointUrl();
  if (configured) {
    return u.origin === configured.origin;
  }
  // Fallback (should be rare): allow localhost only.
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
}

function pickAllowedHeaders(h) {
  const out = {};
  const src = h && typeof h === 'object' ? h : {};
  // Allowlist only what we need.
  if (typeof src.Authorization === 'string') out.Authorization = src.Authorization;
  if (typeof src.authorization === 'string') out.Authorization = src.authorization;
  if (typeof src.Accept === 'string') out.Accept = src.Accept;
  if (typeof src.accept === 'string') out.Accept = src.accept;
  return out;
}

function handleProxyFetch(request, sender, sendResponse) {
    if (!globalThis.LexoraProtocol || typeof LexoraProtocol.isProxyFetchRequest !== 'function') {
      sendResponse({ success: false, error: 'Protocol unavailable.' });
      return false;
    }
    if (!LexoraProtocol.isProxyFetchRequest(request)) {
      sendResponse({ success: false, error: 'Invalid proxy request.' });
      return false;
    }
    // Only the extension UI should be allowed to use the proxy.
    if (!isExtensionSender(sender)) {
      sendResponse({ success: false, error: 'Unauthorized sender.' });
      return false;
    }

    // Validate URL + restrict destination.
    let targetUrl;
    try {
      targetUrl = new URL(request.url);
    } catch (_) {
      sendResponse({ success: false, error: 'Invalid URL.' });
      return false;
    }
    if (!isAllowedProxyUrl(targetUrl)) {
      sendResponse({ success: false, error: 'Blocked URL (not in allowlist).' });
      return false;
    }

    // Restrict method.
    const method = (request.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      sendResponse({ success: false, error: 'Blocked method.' });
      return false;
    }

    // Basic payload cap (avoid huge storage/DoS payloads).
    const bodyObj = request.body == null ? null : request.body;
    let bodyJson = undefined;
    if (bodyObj != null) {
      try {
        bodyJson = JSON.stringify(bodyObj);
      } catch (_) {
        sendResponse({ success: false, error: 'Invalid JSON body.' });
        return false;
      }
      if (bodyJson.length > 250_000) {
        sendResponse({ success: false, error: 'Request body too large.' });
        return false;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      ...pickAllowedHeaders(request.headers),
    };

    fetch(targetUrl.toString(), { method, headers, body: bodyJson })
      .then(async (r) => {
        const contentType = r.headers.get('content-type') || '';
        const text = await r.text();

        let data = null;
        let jsonOk = false;
        try {
          data = JSON.parse(text);
          jsonOk = true;
        } catch (_) {}

        if (!r.ok) {
          const error =
            (jsonOk && data && (data.error?.message || data.message)) ||
            `HTTP ${r.status}`;
          throw Object.assign(new Error(String(error)), {
            __lexoraHttp: {
              ok: false,
              status: r.status,
              contentType,
              data: jsonOk ? data : null,
              __debugSnippet: (globalThis.DEBUG ? (text || '').slice(0, 800) : undefined),
            },
          });
        }

        if (!jsonOk) {
          throw Object.assign(new Error(`Non-JSON response (HTTP ${r.status}).`), {
            __lexoraHttp: {
              ok: true,
              status: r.status,
              contentType,
              __debugSnippet: (globalThis.DEBUG ? (text || '').slice(0, 800) : undefined),
            },
          });
        }

        return { data, meta: { ok: true, status: r.status, contentType } };
      })
      .then(({ data, meta }) => sendResponse({ success: true, data, meta }))
      .catch((err) => {
        const http = err && err.__lexoraHttp ? err.__lexoraHttp : null;
        sendResponse({ success: false, error: err?.message || String(err), http });
      });
    return true;
}

function handleHighlightRelay(request) {
    if (!globalThis.LexoraProtocol) return false;
    const ok =
      request.action === LexoraProtocol.ACTIONS.HIGHLIGHT_WORD
        ? LexoraProtocol.isHighlightWordRequest(request)
        : LexoraProtocol.isClearHighlightRequest(request);
    if (!ok) return false;
    browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) return;
      // If optional `webNavigation` permission isn't granted, fall back to top frame only.
      if (!browserAPI.webNavigation || typeof browserAPI.webNavigation.getAllFrames !== 'function') {
        globalThis.sendMessageSafe(browserAPI, tab.id, request);
        return;
      }
      try {
        browserAPI.webNavigation.getAllFrames({ tabId: tab.id }, frames => {
          if (!frames) {
            globalThis.sendMessageSafe(browserAPI, tab.id, request);
            return;
          }
          for (const frame of frames) {
            globalThis.sendMessageSafe(browserAPI, tab.id, request, { frameId: frame.frameId });
          }
        });
      } catch (_) {
        globalThis.sendMessageSafe(browserAPI, tab.id, request);
      }
    });
    return false;
}

function handleSelectionActions(request, sender) {
    if (!globalThis.LexoraProtocol || !LexoraProtocol.isTextSelectionRequest(request)) return false;
    const G = globalThis.LexoraMessageGuards;
    if (!G || !G.isTrustedSelectionSender(sender, browserAPI.runtime?.id)) return false;

    const text = G.clampSelectionText(request.text);
    if (!text) return false;

    // If it's just reading, we create a pseudo-lesson
    if (request.action === ACTIONS.CAPTURE_TEXT) {
      if (!sender?.tab?.id) return false;
      const pseudoLesson = {
        title: 'Selected Text',
        content: text,
        url: typeof sender.tab.url === 'string' ? sender.tab.url : '',
      };
      browserAPI.storage.local.set({ currentLesson: pseudoLesson, autoPlaySelectedText: true });
      globalThis.sendMessageSafe(browserAPI, sender.tab.id, { action: ACTIONS.SET_HIGHLIGHT_ANCHOR, text });
      return;
    }

    // askAiAboutText — same trust + size limits as captureText
    globalThis.sendRuntimeMessageSafe(browserAPI, { ...request, text });
    return false;
}

function handleTriggerDeepCapture(request, sendResponse) {
  let responded = false;
  const respondOnce = (payload) => {
    if (responded) return;
    responded = true;
    try { sendResponse(payload); } catch (e) { globalThis.debugLog('Capture', 'Response error', e); }
  };
  // Hard timeout: never leave UI hanging (MV3 SW + permissions can fail silently).
  const timeoutId = setTimeout(() => {
    respondOnce({ success: false, error: 'Capture timed out.' });
  }, 20000);

    const requestedTabId = Number.isInteger(request?.tabId) ? request.tabId : null;
    const captureTabId = (tabId) => {
      if (!tabId) {
        clearTimeout(timeoutId);
        respondOnce({ success: false, error: 'No active tab' });
        return;
      }

      try {
        (async () => {
          let results;
          try {
            await browserAPI.scripting.executeScript({
              target: { tabId, allFrames: true },
              files: ['capture-extractor.js'],
            });
            results = await browserAPI.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => {
                return globalThis.LexoraCaptureExtractor?.extractPageContent(document, location) || null;
              },
            });
          } catch (e) {
            clearTimeout(timeoutId);
            globalThis.debugLog('Capture', `Extraction failed: ${e.message}`, e);
            respondOnce({ success: false, error: e?.message || 'Capture failed.' });
            return;
          }

          try {
            const valid = (results || [])
              .map(r => r.result)
              .filter(r => r && r.content && r.content.length > 80);

            if (!valid.length) {
              clearTimeout(timeoutId);
              respondOnce({ success: false, error: 'No content found on this page.' });
              globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: false });
              return;
            }

            const bestRaw = valid.reduce((a, b) => a.content.length >= b.content.length ? a : b);
            const best = cleanCapturedLessonNonAi(bestRaw);

            browserAPI.storage.local.set({ currentLesson: best });
            clearTimeout(timeoutId);
            respondOnce({ success: true, data: best });
            globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: true });
          } catch (_e) {
            globalThis.debugLog('Capture', 'Failed to store lesson', _e);
            try {
              const fallback = (results || [])
                .map(r => r.result)
                .filter(r => r && r.content && r.content.length > 80)
                .reduce((a, b) => a.content.length >= b.content.length ? a : b, null);
              if (fallback) {
                const polished = cleanCapturedLessonNonAi(fallback);
                browserAPI.storage.local.set({ currentLesson: polished });
                clearTimeout(timeoutId);
                respondOnce({ success: true, data: polished });
                globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: true });
              } else {
                clearTimeout(timeoutId);
                globalThis.debugLog('Capture', `Extraction failed: ${_e.message}`, _e);
                respondOnce({ success: false, error: _e?.message || 'Capture failed' });
                globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: false });
              }
            } catch (e) {
              clearTimeout(timeoutId);
              globalThis.debugLog('Capture', `Fatal capture error: ${e.message}`, e);
              respondOnce({ success: false, error: e?.message || 'Capture failed' });
            }
          }
        })();
      } catch (e) {
        clearTimeout(timeoutId);
        globalThis.debugLog('Capture', `Script error: ${e.message}`, e);
        respondOnce({ success: false, error: e?.message || 'Capture failed' });
      }
    };

    if (requestedTabId) {
      captureTabId(requestedTabId);
      return true;
    }

    browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      captureTabId(tab && tab.id);
    });
    return true; // async
}

function handleProbeCapturable(request, sendResponse) {
    browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) {
        sendResponse({ success: true, capturable: false, status: 'no_tab', reason: 'No active tab.' });
        return;
      }

      const url = tab.url || '';
      // Restricted pages cannot run content scripts / executeScript.
      if (/^(about:|chrome:|chrome-extension:|moz-extension:|edge:|vivaldi:)/i.test(url)) {
        sendResponse({
          success: true,
          capturable: false,
          status: 'restricted',
          reason: 'This page type blocks extraction. Open a normal webpage or PDF viewer tab.',
        });
        return;
      }

      browserAPI.scripting.executeScript(
        {
          target: { tabId: tab.id, allFrames: true },
          files: ['capture-extractor.js'],
        },
        () => {
          if (browserAPI.runtime.lastError) {
            sendResponse({
              success: true,
              capturable: false,
              status: 'restricted',
              reason: browserAPI.runtime.lastError.message || 'This page blocks extraction.',
            });
            return;
          }

          browserAPI.scripting.executeScript(
        {
          target: { tabId: tab.id, allFrames: true },
          func: () => {
            return globalThis.LexoraCaptureExtractor?.probePageContent(document, location) || {
              capturable: false,
              status: 'not_ready',
              reason: 'Capture extractor unavailable.',
            };
          },
        },
        (results) => {
          try {
            if (browserAPI.runtime.lastError) {
              sendResponse({
                success: true,
                capturable: false,
                status: 'restricted',
                reason: browserAPI.runtime.lastError.message || 'This page blocks extraction.',
              });
              return;
            }
            const best = (results || [])
              .map((r) => r.result)
              .find((r) => r && typeof r.capturable === 'boolean');

            if (best) {
              sendResponse({ success: true, ...best });
            } else {
              sendResponse({ success: true, capturable: false, status: 'not_ready', reason: 'No readable content detected.' });
            }
          } catch (e) {
            globalThis.debugLog('Probe', 'Probe error', e);
            sendResponse({ success: true, capturable: false, status: 'not_ready', reason: e?.message || 'Probe failed.' });
          }
        }
      );
        }
      );
    });
    return true; // async
}

function handleAutoCaptureSave(request) {
  if (!globalThis.LexoraProtocol || !LexoraProtocol.isAutoCaptureSaveRequest(request)) return false;
  const G = globalThis.LexoraMessageGuards;
  const lesson = G && G.normalizeAutoCaptureLesson ? G.normalizeAutoCaptureLesson(request.data) : null;
  if (!lesson) return false;
  try {
    const polished = cleanCapturedLessonNonAi(lesson);
    browserAPI.storage.local.set({ currentLesson: polished });
  } catch (e) {
    globalThis.debugLog('Capture', 'Failed to polish capture', e);
    browserAPI.storage.local.set({ currentLesson: lesson });
  }
  return false;
}

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action =
    (globalThis.LexoraProtocol && LexoraProtocol.getAction(request)) ||
    (request && typeof request.action === 'string' ? request.action : null);

  switch (action) {
    case ACTIONS.PROXY_FETCH:
      return handleProxyFetch(request, sender, sendResponse);
    case ACTIONS.HIGHLIGHT_WORD:
    case ACTIONS.CLEAR_HIGHLIGHT:
      return handleHighlightRelay(request);
    case ACTIONS.CAPTURE_TEXT:
    case ACTIONS.ASK_AI_ABOUT_TEXT:
      return handleSelectionActions(request, sender);
    case ACTIONS.TRIGGER_DEEP_CAPTURE:
      return handleTriggerDeepCapture(request, sendResponse);
    case ACTIONS.PROBE_CAPTURABLE:
      return handleProbeCapturable(request, sendResponse);
    case ACTIONS.AUTO_CAPTURE_SAVE:
      return handleAutoCaptureSave(request);
    default:
      return false;
  }
});

// ── Action Click: Toggle Overlay ────────────────────────────────────────────
async function openSidebarFallback(_tab) {
  try {
    // Firefox: sidebar_action
    if (browserAPI.sidebarAction && typeof browserAPI.sidebarAction.open === 'function') {
      await browserAPI.sidebarAction.open();
      return true;
    }
  } catch (err) {
    globalThis.debugLog('Omnibox', 'Sidebar fail', err);
  }
  try {
    // Chromium: sidePanel (if available)
    if (browserAPI.sidePanel && typeof browserAPI.sidePanel.open === 'function') {
      const win = await browserAPI.windows.getCurrent();
      await browserAPI.sidePanel.open({ windowId: win.id });
      return true;
    }
  } catch (err) {
    globalThis.debugLog('Omnibox', 'Sidepanel fail', err);
  }

  return false;
}

browserAPI.action.onClicked.addListener((_tab) => {
  if (!_tab || !_tab.id) return;

  const sendToTab = (tabId, msg) =>
    new Promise((resolve, reject) => {
      try {
        browserAPI.tabs.sendMessage(tabId, msg, (resp) => {
          const err = browserAPI.runtime.lastError;
          if (err) reject(err);
          else resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });

  sendToTab(_tab.id, { action: ACTIONS.TOGGLE_OVERLAY })
    .catch(async (err) => {
      // If content script isn't there, inject and retry.
      globalThis.debugLog('Action', 'Overlay toggle failed, attempting injection', err);
      try {
        await browserAPI.scripting.executeScript({
          target: { tabId: _tab.id, allFrames: true },
          files: ['capture-extractor.js', 'content.js'],
        });
        await sendToTab(_tab.id, { action: ACTIONS.TOGGLE_OVERLAY });
      } catch (e) {
        globalThis.debugLog('Action', 'Injection/Toggle failed, falling back to sidebar', e);
        openSidebarFallback(_tab);
      }
    });
});

// ── Auto-Capture: Trigger capture when navigation completes ───────────────────
if (browserAPI.webNavigation && browserAPI.webNavigation.onCompleted) {
  browserAPI.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      browserAPI.storage.local.get(['lexoraConfig'], (res) => {
        if (res.lexoraConfig && res.lexoraConfig.autoCapture) {
          // Trigger capture for this tab
          // Wait a moment for dynamic content to load before capturing
          setTimeout(() => {
            browserAPI.scripting.executeScript(
              {
                target: { tabId: details.tabId },
                files: ['capture-extractor.js'],
              },
              () => {
                if (browserAPI.runtime.lastError) return;
                browserAPI.scripting.executeScript(
                  {
                    target: { tabId: details.tabId },
                    func: () => {
                      return globalThis.LexoraCaptureExtractor?.extractPageContent(document, location) || null;
                    },
                  },
                  (results) => {
                    try {
                      if (browserAPI.runtime.lastError) return;
                      const best = (results || [])
                        .map((r) => r.result)
                        .find((r) => r && r.content && r.content.length > 80);
                      if (best) handleAutoCaptureSave({ action: ACTIONS.AUTO_CAPTURE_SAVE, data: best });
                    } catch (e) {
                      globalThis.debugLog('ContentScript', 'Failed to execute script fallback', e);
                    }
                  }
                );
              }
            );
          }, 2000);
        }
      });
    }
  });
}
