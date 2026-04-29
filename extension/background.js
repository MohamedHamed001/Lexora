// background.js
try {
  importScripts('protocol.js');
  importScripts('storage.js');
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
    // If it's just reading, we create a pseudo-lesson
    if (request.action === 'captureText') {
      const pseudoLesson = {
        title: 'Selected Text',
        content: request.text,
        url: sender.tab ? sender.tab.url : ''
      };
      browserAPI.storage.local.set({ currentLesson: pseudoLesson, autoPlaySelectedText: true });

      browserAPI.tabs.sendMessage(sender.tab.id, { action: 'setHighlightAnchor', text: request.text }).catch(() => {});
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
            results = await browserAPI.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => {
            // Never capture our own sidepanel / extension UI (injected with allFrames: true).
            const p = location.protocol;
            if (
              p === 'chrome-extension:' ||
              p === 'moz-extension:' ||
              p === 'webkit-extension:' ||
              p === 'chrome-search:'
            ) {
              return null;
            }

            const normalizeLine = (s) =>
              (s || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            // Semantic selectors cover the broadest range of modern sites.
            // Ordered from most to least specific so the leaf-filter below
            // removes duplicate content from parent/child matches.
            const selectors = [
              // Block-level content elements
              'article', 'main', '[role="main"]',
              // Semantic sectioning
              'section > p', 'section > h1', 'section > h2', 'section > h3', 'section > h4',
              // Standard body content
              'h1','h2','h3','h4',
              'p', 'li',
              'blockquote',
              'pre', 'code',
            ];
            const allEls = Array.from(document.querySelectorAll(selectors.join(',')));
            // Keep only "leaf" matches: drop a node if another matched node sits inside it.
            // Otherwise a card/container's innerText duplicates every nested p/li/h (common in hide/show & lesson UIs).
            const leafEls = allEls.filter((el) =>
              !allEls.some((other) => other !== el && el.contains(other))
            );

            const blocks = [];
            const seen = new Set();
            leafEls.forEach((el) => {
              if (el.closest('nav,button,header,footer,[role="navigation"]')) return;
              const isVisible = !!el.offsetParent;
              const txt = normalizeLine(isVisible ? el.innerText : el.textContent);
              if (txt.length > 10 && !seen.has(txt)) {
                seen.add(txt);
                blocks.push({ tag: el.tagName, text: txt });
              }
            });

            const htmlFormatted = blocks.map(b =>
              /^H\d$/.test(b.tag) ? `\n## ${b.text}\n` : b.text
            ).join('\n\n');

            // PDF-in-page (PDF.js) support: extract from the text layer when present.
            const pdfEmbeds = [
              ...document.querySelectorAll(
                'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], iframe[src*="viewer"], iframe[src*="pdf"]'
              ),
            ];

            const pdfTextNodes = [
              ...document.querySelectorAll(
                '.textLayer span, [class*="textLayer"] span, .textLayer div, [class*="textLayer"] div'
              ),
            ];

            const pdfLines = [];
            if (pdfTextNodes.length) {
              for (const node of pdfTextNodes) {
                const t = normalizeLine(node.textContent);
                if (!t) continue;
                if (t.length > 2 && !seen.has(t)) {
                  seen.add(t);
                  pdfLines.push(t);
                }
              }
            }

            const pdfText = pdfLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

            const content =
              pdfText.length >= 400 && pdfText.length > htmlFormatted.trim().length * 0.8
                ? pdfText
                : htmlFormatted.trim();

            const pdfUrl =
              pdfEmbeds.find((e) => e && (e.src || e.data))?.src ||
              pdfEmbeds.find((e) => e && (e.src || e.data))?.data ||
              '';

            if (!content || content.length < 80) {
              if (pdfUrl) {
                return {
                  title: document.title.split(' - ')[0] || document.title || 'Captured Page',
                  content: `## PDF detected\n\nThis page appears to embed a PDF, but no selectable text layer was found to extract from.\n\nPDF URL: ${pdfUrl}`.trim(),
                  url: location.href,
                };
              }
              return null;
            }

            return {
              title:   document.title.split(' - ')[0] || document.title || 'Captured Page',
              content,
              url:     location.href,
            };
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
          func: () => {
            const p = location.protocol;
            if (
              p === 'chrome-extension:' ||
              p === 'moz-extension:' ||
              p === 'webkit-extension:' ||
              p === 'chrome-search:'
            ) {
              return { capturable: false, status: 'restricted', reason: 'Extension pages are not capturable.' };
            }

            const normalizeLine = (s) =>
              (s || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            // PDF.js text layer
            const pdfTextNodes = [
              ...document.querySelectorAll(
                '.textLayer span, [class*="textLayer"] span, .textLayer div, [class*="textLayer"] div'
              ),
            ];
            let pdfChars = 0;
            for (const n of pdfTextNodes) pdfChars += normalizeLine(n.textContent).length;

            // Basic HTML text signal
            const els = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,li,blockquote'));
            let htmlChars = 0;
            for (const el of els.slice(0, 250)) {
              const t = normalizeLine(!!el.offsetParent ? el.innerText : el.textContent);
              if (t.length > 10) htmlChars += t.length;
              if (htmlChars > 2500) break;
            }

            const capturable = pdfChars >= 600 || htmlChars >= 800;
            const kind = pdfChars >= 600 ? 'pdf' : (htmlChars >= 800 ? 'html' : 'unknown');
            return {
              capturable,
              status: capturable ? 'ready' : 'not_ready',
              kind,
              pdfChars,
              htmlChars,
              reason: capturable ? 'Ready to capture.' : 'No strong text signal found yet (page may still be loading).',
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
        files: ['content.js'],
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
                func: () => {
                  if (window.lexoraCaptureText) {
                    const data = window.lexoraCaptureText();
                    if (data && data.content && data.content.length > 80) return data;
                  }
                  return null;
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
          }, 2000);
        }
      });
    }
  });
}
