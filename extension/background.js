// background.js
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

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
            const selectors = [
              'h1','h2','h3','h4','p','li',
              '.index--body--299_C',
              '.atom-content',
              '.concept-content',
              "div[class*='index-module--content']",
              "div[class*='text-lesson']",
              "div[class*='video-lesson']",
            ];
            const blocks = [];
            const seen   = new Set();
            document.querySelectorAll(selectors.join(',')).forEach(el => {
              if (!el.offsetParent) return;
              if (el.closest('nav,button,header,footer,[role="navigation"]')) return;
              const txt = el.innerText.replace(/\s+/g,' ').trim();
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
          if (browserAPI.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
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

          const best = valid.reduce((a, b) => a.content.length >= b.content.length ? a : b);
          browserAPI.storage.local.set({ currentLesson: best });
          sendResponse({ success: true, data: best });
          browserAPI.tabs.sendMessage(tab.id, { action: 'captureFinished', success: true });
        }
      );
    });
    return true; // async
  }
});

// ── Action Click: Toggle Overlay ────────────────────────────────────────────
browserAPI.action.onClicked.addListener((tab) => {
  browserAPI.tabs.sendMessage(tab.id, { action: 'toggleOverlay' }).catch(() => {
    // Content script might not be loaded yet, try injecting manually
    browserAPI.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).then(() => {
      browserAPI.tabs.sendMessage(tab.id, { action: 'toggleOverlay' });
    });
  });
});
