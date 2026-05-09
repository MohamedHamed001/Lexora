// background.js
// Chrome MV3 runs background.js in a service worker (importScripts available).
// Firefox MV3 loads background.scripts in order as an event page (no importScripts).
// In Firefox, the helpers below are already attached to globalThis by the
// preceding manifest entries, so we only call importScripts when it exists.
if (typeof importScripts === 'function') {
  importScripts('debug-log.js');
  importScripts('protocol.js');
  importScripts('storage.js');
  importScripts('lexora-constants.js');
  importScripts('message-guards.js');
  importScripts('proxy.js');
  importScripts('lesson-capture.js');
  importScripts('capture-extractor.js');
  importScripts('capture-clean.js');
}

const browserAPI =
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
  (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

if (!browserAPI) {
  throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}

/** Injected into pages (order matters): capture helper, content modules, bootstrap. */
const LEXORA_PAGE_SCRIPT_FILES = Object.freeze([
  'lexora-constants.js',
  'capture-extractor.js',
  'content/highlighter-alignment.js',
  'content/content-highlighter.js',
  'content/content-overlay.js',
  'content/content-selection-bar.js',
  'content/content-router.js',
  'content.js',
]);

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
const STORAGE_KEYS = (globalThis.LexoraStorage && LexoraStorage.KEYS) || {
  CONFIG: 'lexoraConfig',
  HIGHLIGHT_TARGET: 'lexoraHighlightTarget',
  PENDING_ASK_AI: 'lexoraPendingAskAi',
};
const MIN_CAPTURE_CONTENT_CHARS =
  (globalThis.LexoraConstants && globalThis.LexoraConstants.MIN_CAPTURE_CONTENT_CHARS) || 80;
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

function handleProxyFetch(request, sender, sendResponse) {
  if (!globalThis.LexoraProxy || typeof LexoraProxy.handleProxyFetch !== 'function') {
    sendResponse({ success: false, error: 'Proxy module unavailable.' });
    return false;
  }
  return LexoraProxy.handleProxyFetch(browserAPI, {
    request,
    sender,
    sendResponse,
    isExtensionSender,
    getConfiguredChatEndpointUrl,
  });
}

function handleHighlightRelay(request) {
    if (!globalThis.LexoraProtocol) return false;
    const ok =
      request.action === LexoraProtocol.ACTIONS.HIGHLIGHT_WORD
        ? LexoraProtocol.isHighlightWordRequest(request)
        : LexoraProtocol.isClearHighlightRequest(request);
    if (!ok) return false;
    const targetKey = STORAGE_KEYS.HIGHLIGHT_TARGET;

    function broadcastAllFrames(tabId) {
      if (!browserAPI.webNavigation || typeof browserAPI.webNavigation.getAllFrames !== 'function') {
        globalThis.sendMessageSafe(browserAPI, tabId, request);
        return;
      }
      try {
        browserAPI.webNavigation.getAllFrames({ tabId }, (frames) => {
          if (!frames) {
            globalThis.sendMessageSafe(browserAPI, tabId, request);
            return;
          }
          for (const frame of frames) {
            globalThis.sendMessageSafe(browserAPI, tabId, request, { frameId: frame.frameId });
          }
        });
      } catch (_) {
        globalThis.sendMessageSafe(browserAPI, tabId, request);
      }
    }

    function fallbackActiveTab() {
      browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return;
        broadcastAllFrames(tab.id);
      });
    }

    browserAPI.storage.local.get([targetKey], (res) => {
      const target = res && res[targetKey];
      const tTab = target && typeof target.tabId === 'number' ? target.tabId : null;
      const tFrame = target && Number.isInteger(target.frameId) ? target.frameId : null;

      if (tTab == null) {
        fallbackActiveTab();
        return;
      }

      browserAPI.tabs.get(tTab, (tab) => {
        if (browserAPI.runtime.lastError || !tab) {
          fallbackActiveTab();
          return;
        }
        if (tFrame != null) {
          globalThis.sendMessageSafe(browserAPI, tTab, request, { frameId: tFrame });
          return;
        }
        broadcastAllFrames(tTab);
      });
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
      const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
      browserAPI.storage.local.set({
        currentLesson: pseudoLesson,
        autoPlaySelectedText: true,
        [STORAGE_KEYS.HIGHLIGHT_TARGET]: { tabId: sender.tab.id, frameId },
      });
      globalThis.sendMessageSafe(browserAPI, sender.tab.id, { action: ACTIONS.SET_HIGHLIGHT_ANCHOR, text });
      return;
    }

    // askAiAboutText — storage only so one delivery path (side panel: onChanged + startup drain).
    if (request.action === ACTIONS.ASK_AI_ABOUT_TEXT) {
      try {
        browserAPI.storage.local.set({
          [STORAGE_KEYS.PENDING_ASK_AI]: { text, ts: Date.now() },
        });
      } catch (e) {
        globalThis.debugLog('Selection', 'pending ask-ai storage failed', e);
      }
    }
    return false;
}

function handleTriggerDeepCapture(request, sendResponse) {
  const LC = globalThis.LexoraLessonCapture;
  if (!LC || typeof LC.beginDeepCaptureOp !== 'function') {
    sendResponse({ success: false, error: 'Capture module unavailable.' });
    return true;
  }

  let responded = false;
  const respondOnce = (payload) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch (e) {
      globalThis.debugLog('Capture', 'Response error', e);
    }
  };

  const opId = LC.beginDeepCaptureOp();
  const timeoutId = setTimeout(() => {
    LC.invalidateDeepCaptureIfCurrent(opId);
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
            files: ['lexora-constants.js', 'capture-extractor.js'],
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

        if (!LC.isDeepCaptureOpCurrent(opId) || responded) {
          clearTimeout(timeoutId);
          return;
        }

        const mapped = (results || []).map((r) => ({
          result: r.result,
          frameId: Number.isInteger(r.frameId) ? r.frameId : 0,
        }));

        try {
          let bestRaw = null;
          let bestFrameId = 0;
          for (const x of mapped) {
            const r = x.result;
            if (!r || !r.content || r.content.length <= MIN_CAPTURE_CONTENT_CHARS) continue;
            if (!bestRaw || r.content.length >= bestRaw.content.length) {
              bestRaw = r;
              bestFrameId = Number.isInteger(x.frameId) ? x.frameId : 0;
            }
          }

          if (!bestRaw) {
            clearTimeout(timeoutId);
            respondOnce({ success: false, error: 'No content found on this page.' });
            globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: false });
            return;
          }

          const best = cleanCapturedLessonNonAi(bestRaw);

          if (!LC.isDeepCaptureOpCurrent(opId) || responded) {
            clearTimeout(timeoutId);
            return;
          }

          browserAPI.storage.local.set({
            currentLesson: best,
            [STORAGE_KEYS.HIGHLIGHT_TARGET]: { tabId, frameId: bestFrameId },
          });
          clearTimeout(timeoutId);
          respondOnce({ success: true, data: best });
          globalThis.sendMessageSafe(browserAPI, tabId, { action: ACTIONS.CAPTURE_FINISHED, success: true });
        } catch (_e) {
          globalThis.debugLog('Capture', 'Failed to store lesson', _e);
          try {
            let fallback = null;
            let fbFrame = 0;
            for (const x of mapped) {
              const r = x.result;
              if (!r || !r.content || r.content.length <= MIN_CAPTURE_CONTENT_CHARS) continue;
              if (!fallback || r.content.length >= fallback.content.length) {
                fallback = r;
                fbFrame = Number.isInteger(x.frameId) ? x.frameId : 0;
              }
            }
            if (fallback) {
              if (!LC.isDeepCaptureOpCurrent(opId) || responded) {
                clearTimeout(timeoutId);
                return;
              }
              const polished = cleanCapturedLessonNonAi(fallback);
              browserAPI.storage.local.set({
                currentLesson: polished,
                [STORAGE_KEYS.HIGHLIGHT_TARGET]: { tabId, frameId: fbFrame },
              });
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

  browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    captureTabId(tab && tab.id);
  });
  return true;
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
          files: ['lexora-constants.js', 'capture-extractor.js'],
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
          files: [...LEXORA_PAGE_SCRIPT_FILES],
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
      const LC = globalThis.LexoraLessonCapture;
      const opId = LC && typeof LC.bumpAutoCaptureAndGetId === 'function' ? LC.bumpAutoCaptureAndGetId() : 0;
      browserAPI.storage.local.get(['lexoraConfig'], (res) => {
        if (res.lexoraConfig && res.lexoraConfig.autoCapture) {
          setTimeout(() => {
            if (LC && !LC.isAutoCaptureOpCurrent(opId)) return;
            browserAPI.scripting.executeScript(
              {
                target: { tabId: details.tabId },
                files: ['lexora-constants.js', 'capture-extractor.js'],
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
                      if (LC && !LC.isAutoCaptureOpCurrent(opId)) return;
                      const best = (results || [])
                        .map((r) => r.result)
                        .find((r) => r && r.content && r.content.length > MIN_CAPTURE_CONTENT_CHARS);
                      if (!best) return;
                      let polished = best;
                      try {
                        polished = cleanCapturedLessonNonAi(best);
                      } catch (e) {
                        globalThis.debugLog('Capture', 'Failed to polish auto-capture', e);
                      }
                      browserAPI.storage.local.set({
                        currentLesson: polished,
                        [STORAGE_KEYS.HIGHLIGHT_TARGET]: { tabId: details.tabId, frameId: 0 },
                      });
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
