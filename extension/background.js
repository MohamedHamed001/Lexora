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
              const txt = (isVisible ? el.innerText : el.textContent)
                .replace(/\s+/g, ' ')
                .trim();
              if (txt.length > 10 && !seen.has(txt)) {
                seen.add(txt);
                blocks.push({ tag: el.tagName, text: txt });
              }
            });
            if (!blocks.length) return null;
            const formatted = blocks.map(b =>
              /^H\d$/.test(b.tag) ? `\n## ${b.text}\n` : b.text
            ).join('\n\n');
            return {
              title:   document.title.split(' - ')[0] || document.title || 'Captured Page',
              content: formatted.trim(),
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
});

// ── Action Click: Toggle Overlay ────────────────────────────────────────────
browserAPI.action.onClicked.addListener((tab) => {
  browserAPI.tabs.sendMessage(tab.id, { action: 'toggleOverlay' }).catch(() => {
    browserAPI.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    }).then(() => {
      browserAPI.tabs.sendMessage(tab.id, { action: 'toggleOverlay' });
    });
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
