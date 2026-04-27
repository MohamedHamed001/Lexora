// content.js
// Responsible for injecting page elements and capturing content.

(function () {
  'use strict';

  const browserAPI =
    (typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome : null) ||
    (typeof browser !== 'undefined' && browser?.runtime?.getURL ? browser : null);

  if (!browserAPI) {
    throw new Error('Extension runtime API not found (chrome.runtime/browser.runtime missing)');
  }

  const BTN_ID    = 'ai-study-companion-btn';
  const BTN_COLOR = 'rgba(109, 40, 217, 0.92)';

  // ── Overlay Injection Logic ──────────────────────────────────────────────
  let overlayHost = null;
  let overlayShadow = null;
  let overlayIframe = null;
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  function destroyOverlay() {
    try {
      if (overlayIframe) overlayIframe.src = 'about:blank';
    } catch (_) {}
    try {
      if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    } catch (_) {}
    overlayHost = null;
    overlayShadow = null;
    overlayIframe = null;
    isMinimized = false;
    isDragging = false;
  }

  function createOverlay() {
    if (overlayHost) return;
    if (window !== window.top) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'lexora-overlay-root';
    overlayHost.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 420px;
      height: 600px;
      z-index: 2147483647;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, width 0.4s ease, height 0.4s ease, border-radius 0.4s ease;
      transform: translateX(450px);
      opacity: 0;
      pointer-events: none;
      box-shadow: 0 12px 40px rgba(0,0,0,0.3);
      border-radius: 12px;
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    overlayShadow = overlayHost.attachShadow({ mode: 'closed' });

    // Styles for the shadow root
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
      }
      .wrapper {
        position: relative;
        width: 100%;
        height: 100%;
        background: #1a1a1a;
        background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: inherit;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: all 0.4s ease;
      }
      .overlay-header {
        height: 32px;
        background: rgba(255,255,255,0.05);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        user-select: none;
        cursor: move;
      }
      .overlay-title {
        color: rgba(255,255,255,0.5);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        pointer-events: none;
      }
      .nav-controls {
        display: flex;
        gap: 6px;
      }
      iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: transparent;
        transition: opacity 0.3s;
      }
      .control-btn {
        width: 20px;
        height: 20px;
        background: rgba(255,255,255,0.1);
        border: none;
        border-radius: 4px;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: bold;
        transition: all 0.2s;
      }
      .control-btn:hover {
        background: rgba(255,255,255,0.2);
      }
      .close-btn:hover {
        background: rgba(239, 68, 68, 0.8);
      }
      
      /* Minimized State — compact audio strip + expand */
      .minimized-gem {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0 8px;
        box-sizing: border-box;
        background: linear-gradient(135deg, #6d28d9 0%, #4f46e5 100%);
        cursor: grab;
        color: white;
        box-shadow: 0 0 20px rgba(109, 40, 217, 0.5);
        animation: gemPulse 2s infinite ease-in-out;
      }
      .mini-audio-btn {
        flex: 0 0 auto;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 10px;
        background: rgba(255,255,255,0.18);
        color: white;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: background 0.15s;
      }
      .mini-audio-btn:hover {
        background: rgba(255,255,255,0.32);
      }
      .mini-audio-btn:active {
        transform: scale(0.96);
      }
      .mini-expand-btn {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        border: none;
        border-radius: 50%;
        background: rgba(255,255,255,0.22);
        color: white;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-left: 2px;
      }
      .mini-expand-btn:hover {
        background: rgba(255,255,255,0.35);
      }
      @keyframes gemPulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 15px rgba(109, 40, 217, 0.4); }
        50% { transform: scale(1.05); box-shadow: 0 0 25px rgba(109, 40, 217, 0.7); }
      }
      
      /* Cover to prevent iframe from stealing mouse events during drag */
      .drag-cover {
        position: absolute;
        inset: 0;
        z-index: 10;
        display: none;
        cursor: move;
      }
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';

    const dragCover = document.createElement('div');
    dragCover.className = 'drag-cover';

    const gem = document.createElement('div');
    gem.className = 'minimized-gem';
    let gemDragStartPos = null;

    function postToSidepanel(action) {
      try {
        if (overlayIframe && overlayIframe.contentWindow) {
          overlayIframe.contentWindow.postMessage({ type: 'lexora', action }, '*');
        }
      } catch (_) {}
    }

    function makeMiniBtn(label, title, action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-audio-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        postToSidepanel(action);
      });
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('mouseup', (e) => e.stopPropagation());
      return b;
    }

    const miniPrev = makeMiniBtn('⏮', 'Previous sentence', 'prev');
    const miniPlay = makeMiniBtn('▶', 'Play / Pause', 'play-toggle');
    miniPlay.classList.add('mini-play-btn');
    const miniNext = makeMiniBtn('⏭', 'Next sentence', 'next');

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'mini-expand-btn';
    expandBtn.textContent = '⛶';
    expandBtn.title = 'Expand panel';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setMinimized(false);
    });
    expandBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    expandBtn.addEventListener('mouseup', (e) => e.stopPropagation());

    gem.appendChild(miniPrev);
    gem.appendChild(miniPlay);
    gem.appendChild(miniNext);
    gem.appendChild(expandBtn);

    window.addEventListener('message', (ev) => {
      if (!ev.data || ev.data.type !== 'lexora-ui') return;
      if (overlayIframe && ev.source !== overlayIframe.contentWindow) return;
      const g = ev.data.playGlyph;
      if (g && miniPlay) miniPlay.textContent = g;
    });

    gem.onmousedown = (e) => {
      if (e.target.closest('button')) return;
      gemDragStartPos = { x: e.clientX, y: e.clientY };
      isDragging = true;
      const rect = overlayHost.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlayHost.style.transition = 'none';
      e.preventDefault();
    };

    gem.onmouseup = (e) => {
      if (e.target.closest('button')) return;
      if (!gemDragStartPos) return;
      const dx = Math.abs(e.clientX - gemDragStartPos.x);
      const dy = Math.abs(e.clientY - gemDragStartPos.y);
      gemDragStartPos = null;
      if (dx < 5 && dy < 5) setMinimized(false);
    };

    const header = document.createElement('div');
    header.className = 'overlay-header';
    
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Lexora';

    const controls = document.createElement('div');
    controls.className = 'nav-controls';

    const minBtn = document.createElement('button');
    minBtn.className = 'control-btn';
    minBtn.innerHTML = '−';
    minBtn.title = 'Minimize (Keep Playing)';
    minBtn.onclick = (e) => { e.stopPropagation(); setMinimized(true); };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'control-btn close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.title = 'Close & Stop';
    closeBtn.onclick = (e) => { 
      e.stopPropagation();
      destroyOverlay();
    };

    controls.appendChild(minBtn);
    controls.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(controls);

    overlayIframe = document.createElement('iframe');
    overlayIframe.src = browserAPI.runtime.getURL('sidepanel/sidepanel.html');
    overlayIframe.allow = "autoplay; clipboard-write";

    // ── Drag Logic ──────────────────────────────────────────────────────────
    header.onmousedown = (e) => {
      // Don't start dragging if we're clicking a control button
      if (e.target.closest('.control-btn')) return;

      isDragging = true;
      dragCover.style.display = 'block';
      const rect = overlayHost.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlayHost.style.transition = 'none';
      e.preventDefault();
    };

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      
      const minW = isMinimized ? 220 : 420;
      const minH = isMinimized ? 52 : 600;
      const clampedX = Math.max(0, Math.min(window.innerWidth - minW, x));
      const clampedY = Math.max(0, Math.min(window.innerHeight - minH, y));
      
      overlayHost.style.left = clampedX + 'px';
      overlayHost.style.top = clampedY + 'px';
      overlayHost.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        dragCover.style.display = 'none';
        overlayHost.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, width 0.4s ease, height 0.4s ease, border-radius 0.4s ease';
      }
    });

    wrapper.appendChild(header);
    wrapper.appendChild(overlayIframe);
    wrapper.appendChild(gem);
    wrapper.appendChild(dragCover);
    overlayShadow.appendChild(style);
    overlayShadow.appendChild(wrapper);

    document.body.appendChild(overlayHost);
  }

  function setMinimized(min) {
    if (!overlayHost) return;
    isMinimized = min;
    
    if (min) {
      overlayHost.style.width = '220px';
      overlayHost.style.height = '52px';
      overlayHost.style.borderRadius = '26px';
      overlayShadow.querySelector('.minimized-gem').style.display = 'flex';
      overlayIframe.style.opacity = '0';
      overlayIframe.style.pointerEvents = 'none';
      overlayShadow.querySelector('.overlay-header').style.display = 'none';
    } else {
      overlayHost.style.width = '420px';
      overlayHost.style.height = '600px';
      overlayHost.style.borderRadius = '12px';
      overlayShadow.querySelector('.minimized-gem').style.display = 'none';
      overlayIframe.style.opacity = '1';
      overlayIframe.style.pointerEvents = 'auto';
      overlayShadow.querySelector('.overlay-header').style.display = 'flex';
    }
  }

  function toggleOverlay(force) {
    if (window !== window.top) return;
    if (overlayHost && !overlayHost.isConnected) {
      // If the DOM node was removed unexpectedly, reset and recreate.
      destroyOverlay();
    }
    if (!overlayHost) createOverlay();
    
    const isVisible = overlayHost.style.opacity === '1';
    const shouldShow = force !== undefined ? force : !isVisible;

    if (shouldShow) {
      overlayHost.style.transform = 'translateX(0)';
      overlayHost.style.opacity = '1';
      overlayHost.style.pointerEvents = 'auto';
      if (!overlayHost.style.left) {
        overlayHost.style.right = '20px';
        overlayHost.style.top = '20px';
      }
    } else {
      overlayHost.style.transform = 'translateX(500px)';
      overlayHost.style.opacity = '0';
      overlayHost.style.pointerEvents = 'none';
    }
  }

  // ── Word Highlight System ────────────────────────────────────────────────
  // Builds a flat word-by-word index of the entire page in document order.
  // A cursor marches forward through it — guarantees highlights follow
  // reading order, no jumping, no duplicate-text confusion.

  let highlightStyleInjected = false;
  let currentChunkText = null;

  // Page word index: [{word, node, start, end}, ...] in document order
  let pageWords = null;
  let wordCursor = 0;
  // Cache key — if the URL changes the index is stale
  let pageWordsCacheUrl = null;
  // Debounce timer for MutationObserver invalidation
  let pageWordsInvalidateTimer = null;

  // Currently highlighted span elements (for cleanup)
  let activeSpans = [];

  // Watch for significant DOM mutations (e.g. SPA navigations) and invalidate the cache.
  const _pageWordsMO = new MutationObserver(() => {
    clearTimeout(pageWordsInvalidateTimer);
    pageWordsInvalidateTimer = setTimeout(() => {
      if (location.href !== pageWordsCacheUrl) {
        pageWords = null;
        pageWordsCacheUrl = null;
        wordCursor = 0;
      }
    }, 500);
  });
  _pageWordsMO.observe(document.body, { childList: true, subtree: true });


  function injectHighlightStyles() {
    if (highlightStyleInjected) return;
    const s = document.createElement('style');
    s.id = 'lexora-highlight-styles';
    s.textContent = `
      .lexora-hl {
        transition: background 0.12s ease, box-shadow 0.12s ease;
        border-radius: 3px;
      }
      .lexora-hl-active {
        background: rgba(109, 40, 217, 0.35) !important;
        box-shadow: 0 0 8px rgba(109, 40, 217, 0.45);
        border-radius: 3px;
        padding: 1px 2px;
        margin: -1px -2px;
      }
    `;
    document.head.appendChild(s);
    highlightStyleInjected = true;
  }

  function buildPageWords() {
    const words = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script,style,noscript,#lexora-overlay-root,iframe,svg,head')) return NodeFilter.FILTER_REJECT;
        const st = window.getComputedStyle(p);
        if (st.display === 'none' || st.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        words.push({ word: m[0], node, start: m.index, end: m.index + m[0].length });
      }
    }
    return words;
  }

  function norm(w) {
    return w.toLowerCase().replace(/[^\w]/g, '');
  }

  // Aligns chunk words against page words, returning an array of
  // {chunkIdx, pageIdx} pairs. Skips page words that don't appear
  // in the chunk, so only actually-spoken words get highlighted.
  function alignChunkToPage(chunkWords, startIdx) {
    const normed = chunkWords.map(norm);
    const pairs = [];
    let pi = startIdx;
    let misses = 0;

    for (let ci = 0; ci < normed.length && pi < pageWords.length; ci++) {
      let found = false;
      for (let look = 0; look < 35 && pi + look < pageWords.length; look++) {
        if (norm(pageWords[pi + look].word) === normed[ci]) {
          pairs.push({ chunkIdx: ci, pageIdx: pi + look });
          pi = pi + look + 1;
          found = true;
          misses = 0;
          break;
        }
      }
      if (!found) {
        // If a chunk word isn't found (punctuation/quotes/layout), don't immediately
        // advance the page cursor; that can desync and cause long "no highlight" gaps.
        misses++;
        if (misses % 3 === 0) pi++;
      }
    }
    return pairs;
  }

  function findChunkStart(chunkWords) {
    if (!chunkWords.length || !pageWords) return -1;

    const normed = chunkWords.map(norm);

    for (let i = wordCursor; i < pageWords.length; i++) {
      if (norm(pageWords[i].word) !== normed[0]) continue;

      // Verify: check next 1-2 words match within a small window
      let matched = 1;
      let pi = i + 1;
      for (let c = 1; c < Math.min(3, normed.length); c++) {
        for (let look = 0; look < 3 && pi + look < pageWords.length; look++) {
          if (norm(pageWords[pi + look].word) === normed[c]) {
            matched++;
            pi = pi + look + 1;
            break;
          }
        }
      }
      if (matched >= Math.min(2, normed.length)) return i;
    }

    return -1;
  }

  function removeActiveSpans() {
    for (const span of activeSpans) {
      try {
        const parent = span.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
      } catch (_) {}
    }
    activeSpans = [];
  }

  function wrapAlignedWords(pairs) {
    activeSpans = [];

    // Group by text node, preserving order
    const groups = [];
    let lastNode = null;
    for (const { chunkIdx, pageIdx } of pairs) {
      const pw = pageWords[pageIdx];
      if (!pw) continue;
      if (pw.node !== lastNode) {
        groups.push({ node: pw.node, words: [] });
        lastNode = pw.node;
      }
      groups[groups.length - 1].words.push({ chunkIdx, start: pw.start, end: pw.end });
    }

    for (const group of groups) {
      const textNode = group.node;
      const parent = textNode.parentNode;
      if (!parent || !textNode.isConnected) continue;

      const fullText = textNode.textContent;
      const frag = document.createDocumentFragment();
      let pos = 0;

      for (const w of group.words) {
        if (w.start > pos) {
          frag.appendChild(document.createTextNode(fullText.substring(pos, w.start)));
        }
        const span = document.createElement('span');
        span.className = 'lexora-hl';
        span.setAttribute('data-lw', w.chunkIdx);
        span.textContent = fullText.substring(w.start, w.end);
        frag.appendChild(span);
        activeSpans.push(span);
        pos = w.end;
      }

      if (pos < fullText.length) {
        frag.appendChild(document.createTextNode(fullText.substring(pos)));
      }

      textNode.replaceWith(frag);
    }
  }

  function highlightWord(chunkText, wordIndex, attempt = 0) {
    injectHighlightStyles();

    if (chunkText !== currentChunkText) {
      const hadSpans = activeSpans.length > 0;
      removeActiveSpans();
      currentChunkText = chunkText;

      // Rebuild page index on URL change OR after we mutate DOM for highlighting.
      if (!pageWords || hadSpans || location.href !== pageWordsCacheUrl) {
        pageWords = buildPageWords();
        pageWordsCacheUrl = location.href;
        wordCursor = Math.max(0, Math.min(wordCursor, pageWords.length - 1));
      }
      if (wordCursor >= pageWords.length) wordCursor = 0;

      const chunkWords = chunkText.trim().split(/\s+/);
      let matchStart = findChunkStart(chunkWords);

      // Recovery: if we drifted (common across paragraphs / inline formatting),
      // try a wider search window and finally restart from the top.
      if (matchStart < 0 && pageWords && pageWords.length) {
        const prevCursor = wordCursor;
        wordCursor = Math.max(0, prevCursor - 250);
        matchStart = findChunkStart(chunkWords);
        if (matchStart < 0) {
          wordCursor = 0;
          matchStart = findChunkStart(chunkWords);
        }
        if (matchStart < 0) wordCursor = prevCursor;
      }

      if (matchStart >= 0) {
        const pairs = alignChunkToPage(chunkWords, matchStart);
        wrapAlignedWords(pairs);
        if (pairs.length) {
          wordCursor = pairs[pairs.length - 1].pageIdx + 1;
        }
      }
    }


    const prev = document.querySelector('.lexora-hl-active');
    if (prev) prev.classList.remove('lexora-hl-active');

    const target = document.querySelector(`[data-lw="${wordIndex}"]`);
    const fallbackTarget = (() => {
      if (target) return target;
      // If this exact wordIndex wasn't aligned into a span, highlight the nearest
      // previous aligned word so highlighting appears continuous.
      for (let back = 1; back <= 10; back++) {
        const t = document.querySelector(`[data-lw="${wordIndex - back}"]`);
        if (t) return t;
      }
      return null;
    })();

    if (fallbackTarget) {
      fallbackTarget.classList.add('lexora-hl-active');
      fallbackTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // If we couldn't find ANY span to highlight, re-run alignment once from scratch.
    // This fixes cases where DOM changes or punctuation drift cause us to lose the mapping mid-paragraph.
    if (attempt < 1 && chunkText && chunkText.trim()) {
      removeActiveSpans();
      currentChunkText = null;
      pageWords = null;
      pageWordsCacheUrl = null;
      wordCursor = 0;
      highlightWord(chunkText, wordIndex, attempt + 1);
    }
  }

  function clearHighlight(fullReset) {
    const prev = document.querySelector('.lexora-hl-active');
    if (prev) prev.classList.remove('lexora-hl-active');

    removeActiveSpans();
    currentChunkText = null;

    if (fullReset) {
      pageWords = null;
      wordCursor = 0;
    }
  }

  // ── Listen for messages ──────────────────────────────────────────────────
  browserAPI.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureFinished' && overlayHost) {
      // Forward to iframe if needed, or handle locally
    } else if (msg.action === 'toggleOverlay') {
      toggleOverlay();
    } else if (msg.action === 'setHighlightAnchor') {
      try {
        const t = (msg.text || '').trim();
        if (!t) return;
        // Build/rebuild page index and anchor the cursor near the selection start.
        pageWords = buildPageWords();
        pageWordsCacheUrl = location.href;
        const words = t.split(/\s+/).slice(0, 8);
        let anchor = -1;
        if (words.length) {
          const first = norm(words[0]);
          const second = words[1] ? norm(words[1]) : null;
          for (let i = 0; i < pageWords.length; i++) {
            if (norm(pageWords[i].word) !== first) continue;
            if (second) {
              // look ahead a bit for second word
              let ok = false;
              for (let j = 1; j <= 6 && i + j < pageWords.length; j++) {
                if (norm(pageWords[i + j].word) === second) { ok = true; break; }
              }
              if (!ok) continue;
            }
            anchor = i;
            break;
          }
        }
        wordCursor = anchor >= 0 ? anchor : 0;
      } catch (_) {}
    } else if (msg.action === 'highlightWord') {
      highlightWord(msg.chunkText, msg.wordIndex);
    } else if (msg.action === 'clearHighlight') {
      clearHighlight(msg.fullReset);
    }
  });

  let _url = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== _url) {
      _url = location.href;
    }
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ── Text Selection Floating Action Bar ────────────────────────────────────
  let selectionActionBar = null;

  function createSelectionActionBar() {
    selectionActionBar = document.createElement('div');
    selectionActionBar.id = 'lexora-selection-action-bar';
    selectionActionBar.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      background: #1a1a1a;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 4px;
      display: none;
      gap: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-family: system-ui, -apple-system, sans-serif;
    `;

    const btnStyle = `
      background: rgba(255,255,255,0.1);
      color: white;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    `;

    const readBtn = document.createElement('button');
    readBtn.textContent = '🔊 Read';
    readBtn.style.cssText = btnStyle;
    readBtn.onmouseover = () => readBtn.style.background = 'rgba(255,255,255,0.2)';
    readBtn.onmouseout = () => readBtn.style.background = 'rgba(255,255,255,0.1)';
    readBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const text = window.getSelection().toString();
      browserAPI.runtime.sendMessage({ action: 'captureText', text });
      selectionActionBar.style.display = 'none';
      toggleOverlay(true);
    };

    const askBtn = document.createElement('button');
    askBtn.textContent = '✨ Ask AI';
    askBtn.style.cssText = btnStyle;
    askBtn.onmouseover = () => askBtn.style.background = 'rgba(255,255,255,0.2)';
    askBtn.onmouseout = () => askBtn.style.background = 'rgba(255,255,255,0.1)';
    askBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const text = window.getSelection().toString();
      browserAPI.runtime.sendMessage({ action: 'askAiAboutText', text });
      selectionActionBar.style.display = 'none';
      toggleOverlay(true);
    };

    selectionActionBar.appendChild(readBtn);
    selectionActionBar.appendChild(askBtn);
    document.body.appendChild(selectionActionBar);
  }

  document.addEventListener('mouseup', (e) => {
    if (!selectionActionBar) createSelectionActionBar();
    
    // Prevent hiding if clicking on the action bar itself
    if (e.target.closest('#lexora-selection-action-bar')) return;

    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      
      if (text.length > 0 && !isDragging) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        // Position just above the selection
        selectionActionBar.style.display = 'flex';
        
        // Calculate position considering scroll
        const top = window.scrollY + rect.top - selectionActionBar.offsetHeight - 8;
        const left = window.scrollX + rect.left + (rect.width / 2) - (selectionActionBar.offsetWidth / 2);
        
        selectionActionBar.style.top = Math.max(window.scrollY + 8, top) + 'px';
        selectionActionBar.style.left = Math.max(8, left) + 'px';
      } else {
        selectionActionBar.style.display = 'none';
      }
    }, 10);
  });

  document.addEventListener('selectionchange', () => {
    if (selectionActionBar && window.getSelection().toString().trim() === '') {
      selectionActionBar.style.display = 'none';
    }
  });

  // ── Auto Capture Expose ──────────────────────────────────────────────────
  window.lexoraCaptureText = function() {
    const p = location.protocol;
    if (
      p === 'chrome-extension:' ||
      p === 'moz-extension:' ||
      p === 'webkit-extension:' ||
      p === 'chrome-search:'
    ) {
      return null;
    }

    const selectors = [
      'article', 'main', '[role="main"]',
      'section > p', 'section > h1', 'section > h2', 'section > h3', 'section > h4',
      'h1','h2','h3','h4',
      'p', 'li',
      'blockquote',
      'pre', 'code',
    ];
    const allEls = Array.from(document.querySelectorAll(selectors.join(',')));
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
  };

})();
