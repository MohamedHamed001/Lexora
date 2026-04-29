// background.js
try {
  importScripts('protocol.js');
  importScripts('storage.js');
  importScripts('capture-extractor.js');
  importScripts('capture-clean.js');
} catch (_) {
  // Some browsers load SW dependencies differently; keep the SW resilient.
}

const browserAPI =
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
  (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

if (!browserAPI) {
  throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}

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
    if (globalThis.LexoraProtocol && !LexoraProtocol.isProxyFetchRequest(request)) {
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
          const snippet = (text || '').slice(0, 800);
          const error =
            (jsonOk && data && (data.error?.message || data.message)) ||
            `HTTP ${r.status}`;
          throw Object.assign(new Error(String(error)), {
            __lexoraHttp: {
              ok: false,
              status: r.status,
              contentType,
              snippet,
              data: jsonOk ? data : null,
            },
          });
        }

        if (!jsonOk) {
          throw Object.assign(new Error(`Non-JSON response (HTTP ${r.status}).`), {
            __lexoraHttp: {
              ok: true,
              status: r.status,
              contentType,
              snippet: (text || '').slice(0, 800),
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
    if (globalThis.LexoraProtocol) {
      const ok =
        request.action === LexoraProtocol.ACTIONS.HIGHLIGHT_WORD
          ? LexoraProtocol.isHighlightWordRequest(request)
          : LexoraProtocol.isClearHighlightRequest(request);
      if (!ok) return false;
    }
    browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) return;
      // If optional `webNavigation` permission isn't granted, fall back to top frame only.
      if (!browserAPI.webNavigation || typeof browserAPI.webNavigation.getAllFrames !== 'function') {
        browserAPI.tabs.sendMessage(tab.id, request).catch(() => {});
        return;
      }
      try {
        browserAPI.webNavigation.getAllFrames({ tabId: tab.id }, frames => {
          if (!frames) {
            browserAPI.tabs.sendMessage(tab.id, request).catch(() => {});
            return;
          }
          for (const frame of frames) {
            browserAPI.tabs.sendMessage(tab.id, request, { frameId: frame.frameId }).catch(() => {});
          }
        });
      } catch (_) {
        browserAPI.tabs.sendMessage(tab.id, request).catch(() => {});
      }
    });
    return false;
}

function handleSelectionActions(request, sender) {
    if (globalThis.LexoraProtocol && !LexoraProtocol.isTextSelectionRequest(request)) return false;
    if (typeof request.text !== 'string' || !request.text.trim()) return false;
    // If it's just reading, we create a pseudo-lesson
    if (request.action === 'captureText') {
      if (!sender?.tab?.id) return false;
      const pseudoLesson = {
        title: 'Selected Text',
        content: request.text.trim(),
        url: sender.tab ? sender.tab.url : ''
      };
      browserAPI.storage.local.set({ currentLesson: pseudoLesson, autoPlaySelectedText: true });

      browserAPI.tabs.sendMessage(sender.tab.id, { action: 'setHighlightAnchor', text: request.text.trim() }).catch(() => {});
    }
    
    // Broadcast to sidepanel so it can update its UI or fill the chat
    browserAPI.runtime.sendMessage(request).catch(() => {});
    return false;
}

function handleTriggerDeepCapture(request, sendResponse) {
  let responded = false;
  const respondOnce = (payload) => {
    if (responded) return;
    responded = true;
    try { sendResponse(payload); } catch (_) {}
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
              browserAPI.tabs.sendMessage(tabId, { action: 'captureFinished', success: false });
              return;
            }

            const bestRaw = valid.reduce((a, b) => a.content.length >= b.content.length ? a : b);
            const best = cleanCapturedLessonNonAi(bestRaw);

            browserAPI.storage.local.set({ currentLesson: best });
            clearTimeout(timeoutId);
            respondOnce({ success: true, data: best });
            browserAPI.tabs.sendMessage(tabId, { action: 'captureFinished', success: true });
          } catch (_e) {
            // Never leave the UI hanging: fall back to raw capture if anything goes wrong.
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
                browserAPI.tabs.sendMessage(tabId, { action: 'captureFinished', success: true });
              } else {
                clearTimeout(timeoutId);
                respondOnce({ success: false, error: _e?.message || 'Capture failed' });
                browserAPI.tabs.sendMessage(tabId, { action: 'captureFinished', success: false });
              }
            } catch (_) {
              clearTimeout(timeoutId);
              respondOnce({ success: false, error: _e?.message || 'Capture failed' });
            }
          }
        })();
      } catch (e) {
        clearTimeout(timeoutId);
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
          } catch (_e) {
            sendResponse({ success: true, capturable: false, status: 'not_ready', reason: _e?.message || 'Probe failed.' });
          }
        }
      );
        }
      );
    });
    return true; // async
}

function handleAutoCaptureSave(request) {
  if (request.data) {
    try {
      const polished = cleanCapturedLessonNonAi(request.data);
      browserAPI.storage.local.set({ currentLesson: polished });
    } catch (_e) {
      browserAPI.storage.local.set({ currentLesson: request.data });
    }
  }
  return false;
}

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action =
    (globalThis.LexoraProtocol && LexoraProtocol.getAction(request)) ||
    (request && typeof request.action === 'string' ? request.action : null);

  switch (action) {
    case 'proxyFetch':
      return handleProxyFetch(request, sender, sendResponse);
    case 'highlightWord':
    case 'clearHighlight':
      return handleHighlightRelay(request);
    case 'captureText':
    case 'askAiAboutText':
      return handleSelectionActions(request, sender);
    case 'triggerDeepCapture':
      return handleTriggerDeepCapture(request, sendResponse);
    case 'probeCapturable':
      return handleProbeCapturable(request, sendResponse);
    case 'autoCaptureSave':
      return handleAutoCaptureSave(request);
    default:
      // Unknown action: ignore for forward-compat.
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
  } catch (_) {}
  try {
    // Chromium: sidePanel (if available)
    if (browserAPI.sidePanel && typeof browserAPI.sidePanel.open === 'function') {
      const win = await browserAPI.windows.getCurrent();
      await browserAPI.sidePanel.open({ windowId: win.id });
      return true;
    }
  } catch (_) {}

  return false;
}

browserAPI.action.onClicked.addListener((_tab) => {
  // Prefer overlay (best UX on normal webpages). If the page blocks injection (new tab/about:),
  // fall back to opening the browser sidebar when available (Firefox).
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

  sendToTab(_tab.id, { action: 'toggleOverlay' })
    .catch(async () => {
      // If messaging failed, inject the content script then try again.
      await browserAPI.scripting.executeScript({
        target: { tabId: _tab.id, allFrames: true },
        files: ['capture-extractor.js', 'content.js'],
      });
      await sendToTab(_tab.id, { action: 'toggleOverlay' });
    })
    .catch(() => openSidebarFallback(_tab))
    .catch(() => {});
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
                      if (best) handleAutoCaptureSave({ action: 'autoCaptureSave', data: best });
                    } catch (_) {}
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
