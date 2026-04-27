// background.js
try { importScripts('capture-clean.js'); } catch (_) { /* Firefox loads via manifest scripts[] */ }

const browserAPI =
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
  (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

if (!browserAPI) {
  throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
}

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ── LM Studio proxy ──────────────────────────────────────────────────────
  if (request.action === 'proxyFetch') {
    fetch(request.url, {
      method: request.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(request.headers || {}) },
      body: request.body ? JSON.stringify(request.body) : undefined
    })
      .then(r => r.json())
      .then(data => sendResponse({ success: true, data }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Word highlight relay (sidepanel → content script in ALL frames) ─────
  if (request.action === 'highlightWord' || request.action === 'clearHighlight') {
    browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) return;
      browserAPI.webNavigation.getAllFrames({ tabId: tab.id }, frames => {
        if (!frames) {
          browserAPI.tabs.sendMessage(tab.id, request).catch(() => {});
          return;
        }
        for (const frame of frames) {
          browserAPI.tabs.sendMessage(tab.id, request, { frameId: frame.frameId }).catch(() => {});
        }
      });
    });
    return false;
  }

  // ── Text Selection Actions ────────────────────────────────────────────────
  if (request.action === 'captureText' || request.action === 'askAiAboutText') {
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

  // ── Capture: triggered from the overlay or button ────────────────────────
  if (request.action === 'triggerDeepCapture') {
    browserAPI.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }

      browserAPI.scripting.executeScript(
        {
          target: { tabId: tab.id, allFrames: true },
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
        },
        results => {
          (async () => {
            try {
              if (browserAPI.runtime.lastError) {
                const errMsg =
                  browserAPI.runtime.lastError?.message ||
                  'Capture failed (runtime error)';
                sendResponse({ success: false, error: errMsg });
                return;
              }

              const valid = (results || [])
                .map(r => r.result)
                .filter(r => r && r.content && r.content.length > 80);

              if (!valid.length) {
                sendResponse({ success: false, error: 'No content found on this page.' });
                browserAPI.tabs.sendMessage(tab.id, { action: 'captureFinished', success: false });
                return;
              }

              const bestRaw = valid.reduce((a, b) => a.content.length >= b.content.length ? a : b);
              const best = cleanCapturedLessonNonAi(bestRaw);

              browserAPI.storage.local.set({ currentLesson: best });
              sendResponse({ success: true, data: best });
              browserAPI.tabs.sendMessage(tab.id, { action: 'captureFinished', success: true });
            } catch (e) {
              // Never leave the UI hanging: fall back to raw capture if anything goes wrong.
              try {
                const fallback = (results || [])
                  .map(r => r.result)
                  .filter(r => r && r.content && r.content.length > 80)
                  .reduce((a, b) => a.content.length >= b.content.length ? a : b, null);
                if (fallback) {
                  const polished = cleanCapturedLessonNonAi(fallback);
                  browserAPI.storage.local.set({ currentLesson: polished });
                  sendResponse({ success: true, data: polished });
                  browserAPI.tabs.sendMessage(tab.id, { action: 'captureFinished', success: true });
                } else {
                  sendResponse({ success: false, error: e?.message || 'Capture failed' });
                  browserAPI.tabs.sendMessage(tab.id, { action: 'captureFinished', success: false });
                }
              } catch (_) {
                sendResponse({ success: false, error: e?.message || 'Capture failed' });
              }
            }
          })();
        }
      );
    });
    return true; // async
  }

  // ── Probe: is current page capturable? (for UI indicator) ────────────────
  if (request.action === 'probeCapturable') {
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
          } catch (e) {
            sendResponse({ success: true, capturable: false, status: 'not_ready', reason: e?.message || 'Probe failed.' });
          }
        }
      );
    });
    return true; // async
  }
});

// ── Action Click: Toggle Overlay ────────────────────────────────────────────
async function openSidebarFallback(tab) {
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

browserAPI.action.onClicked.addListener((tab) => {
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

  sendToTab(tab.id, { action: 'toggleOverlay' })
    .catch(async () => {
      // If messaging failed, inject the content script then try again.
      await browserAPI.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
      await sendToTab(tab.id, { action: 'toggleOverlay' });
    })
    .catch(() => openSidebarFallback(tab))
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
            browserAPI.scripting.executeScript({
              target: { tabId: details.tabId },
              func: () => {
                if (window.lexoraCaptureText) {
                  const data = window.lexoraCaptureText();
                  if (data && data.content && data.content.length > 80) {
                    chrome.runtime.sendMessage({ action: 'autoCaptureSave', data });
                  }
                }
              }
            }).catch(() => {});
          }, 2000);
        }
      });
    }
  });
}

// Handle autoCaptureSave
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'autoCaptureSave' && request.data) {
    try {
      const polished = cleanCapturedLessonNonAi(request.data);
      browserAPI.storage.local.set({ currentLesson: polished });
    } catch (e) {
      browserAPI.storage.local.set({ currentLesson: request.data });
    }
  }
});
