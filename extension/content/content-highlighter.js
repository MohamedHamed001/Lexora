// In-page TTS word highlighter (DOM). Requires highlighter-alignment.js first.
(function initLexoraContentHighlighter(global) {
  const { norm, alignChunkToPage, findChunkStart } = global.LexoraHighlighterAlignment || {};
  if (!norm || !alignChunkToPage || !findChunkStart) {
    throw new Error('LexoraHighlighterAlignment must load before content-highlighter.js');
  }

  const Highlighter = (function () {
    let highlightStyleInjected = false;
    let currentChunkText = null;
    let pageWords = null;
    let wordCursor = 0;
    let pageWordsCacheUrl = null;
    let pageWordsInvalidateTimer = null;
    let activeSpans = [];
    let spanByChunkIdx = new Map();
    let lastScrollAt = 0;
    let spanWrappingDisabled = false;
    const MAX_PAGE_WORDS_FOR_SPAN_WRAPPING = 20000;
    let maxAcceptedPlaybackGen = -1;

    const _pageWordsMO = new MutationObserver(() => {
      clearTimeout(pageWordsInvalidateTimer);
      pageWordsInvalidateTimer = setTimeout(() => {
        if (location.href !== pageWordsCacheUrl) {
          pageWords = null;
          pageWordsCacheUrl = null;
          wordCursor = 0;
        }
      }, 1000);
    });

    setTimeout(() => {
      const observeTarget = document.querySelector('main') || document.querySelector('article') || document.body;
      _pageWordsMO.observe(observeTarget, { childList: true, subtree: true });
    }, 1000);

    function injectHighlightStyles() {
      if (highlightStyleInjected) return;
      const s = document.createElement('style');
      s.id = 'lexora-highlight-styles';
      s.textContent = `
        .lexora-hl { transition: background 0.12s ease, box-shadow 0.12s ease; border-radius: 3px; }
        .lexora-hl-active { background: rgba(109, 40, 217, 0.35) !important; box-shadow: 0 0 8px rgba(109, 40, 217, 0.45); border-radius: 3px; padding: 1px 2px; margin: -1px -2px; }
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
        },
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

    function removeActiveSpans() {
      for (const span of activeSpans) {
        try {
          const parent = span.parentNode;
          if (!parent) continue;
          parent.replaceChild(document.createTextNode(span.textContent), span);
          parent.normalize();
        } catch (err) {
          if (typeof globalThis.debugLog === 'function') {
            globalThis.debugLog('Highlighter', 'span unwrap failed', err);
          }
        }
      }
      activeSpans = [];
      spanByChunkIdx = new Map();
    }

    function wrapAlignedWords(pairs) {
      activeSpans = [];
      spanByChunkIdx = new Map();
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
          if (w.start > pos) frag.appendChild(document.createTextNode(fullText.substring(pos, w.start)));
          const span = document.createElement('span');
          span.className = 'lexora-hl';
          span.setAttribute('data-lw', w.chunkIdx);
          span.textContent = fullText.substring(w.start, w.end);
          frag.appendChild(span);
          activeSpans.push(span);
          spanByChunkIdx.set(w.chunkIdx, span);
          pos = w.end;
        }
        if (pos < fullText.length) frag.appendChild(document.createTextNode(fullText.substring(pos)));
        textNode.replaceWith(frag);
      }
    }

    function highlightWord(chunkText, wordIndex, attempt = 0, playbackGen) {
      if (playbackGen != null && Number.isInteger(playbackGen) && playbackGen < maxAcceptedPlaybackGen) return;
      if (playbackGen != null && Number.isInteger(playbackGen)) {
        maxAcceptedPlaybackGen = Math.max(maxAcceptedPlaybackGen, playbackGen);
      }
      injectHighlightStyles();
      if (chunkText !== currentChunkText) {
        const hadSpans = activeSpans.length > 0;
        removeActiveSpans();
        currentChunkText = chunkText;
        if (!pageWords || hadSpans || location.href !== pageWordsCacheUrl) {
          pageWords = buildPageWords();
          pageWordsCacheUrl = location.href;
          wordCursor = Math.max(0, Math.min(wordCursor, pageWords.length - 1));
        }
        if (wordCursor >= pageWords.length) wordCursor = 0;
        spanWrappingDisabled = !!(pageWords && pageWords.length > MAX_PAGE_WORDS_FOR_SPAN_WRAPPING);

        const chunkWords = chunkText.trim().split(/\s+/);
        let matchStart = findChunkStart(pageWords, wordCursor, chunkWords);
        if (matchStart < 0 && pageWords && pageWords.length) {
          const prevCursor = wordCursor;
          wordCursor = Math.max(0, prevCursor - 250);
          matchStart = findChunkStart(pageWords, wordCursor, chunkWords);
          if (matchStart < 0) {
            wordCursor = 0;
            matchStart = findChunkStart(pageWords, wordCursor, chunkWords);
          }
          if (matchStart < 0) wordCursor = prevCursor;
        }
        if (matchStart >= 0) {
          const pairs = alignChunkToPage(pageWords, chunkWords, matchStart);
          if (!spanWrappingDisabled) wrapAlignedWords(pairs);
          if (pairs.length) wordCursor = pairs[pairs.length - 1].pageIdx + 1;
        }
      }

      const prev = document.querySelector('.lexora-hl-active');
      if (prev) prev.classList.remove('lexora-hl-active');
      if (spanWrappingDisabled) return;

      const target = spanByChunkIdx.get(wordIndex) || null;
      const fallbackTarget = (() => {
        if (target) return target;
        for (let back = 1; back <= 10; back++) {
          const t = spanByChunkIdx.get(wordIndex - back) || null;
          if (t) return t;
        }
        return null;
      })();

      if (fallbackTarget) {
        fallbackTarget.classList.add('lexora-hl-active');
        const now = Date.now();
        if (now - lastScrollAt > 450) {
          lastScrollAt = now;
          fallbackTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }

      if (attempt < 1 && chunkText && chunkText.trim()) {
        removeActiveSpans();
        currentChunkText = null;
        pageWords = null;
        pageWordsCacheUrl = null;
        wordCursor = 0;
        highlightWord(chunkText, wordIndex, attempt + 1, playbackGen);
      }
    }

    function clearHighlight(fullReset, playbackGen) {
      const prev = document.querySelector('.lexora-hl-active');
      if (prev) prev.classList.remove('lexora-hl-active');
      removeActiveSpans();
      currentChunkText = null;
      if (fullReset) {
        pageWords = null;
        wordCursor = 0;
      }
      if (playbackGen != null && Number.isInteger(playbackGen)) {
        maxAcceptedPlaybackGen = Math.max(maxAcceptedPlaybackGen, playbackGen);
      }
    }

    function setHighlightAnchor(text) {
      try {
        const t = (text || '').trim();
        if (!t) return;
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
              let ok = false;
              for (let j = 1; j <= 6 && i + j < pageWords.length; j++) {
                if (norm(pageWords[i + j].word) === second) {
                  ok = true;
                  break;
                }
              }
              if (!ok) continue;
            }
            anchor = i;
            break;
          }
        }
        wordCursor = anchor >= 0 ? anchor : 0;
      } catch (err) {
        if (typeof globalThis.debugLog === 'function') {
          globalThis.debugLog('Highlighter', 'setHighlightAnchor failed', err);
        }
      }
    }

    return { highlightWord, clearHighlight, setHighlightAnchor };
  })();

  global.LexoraContentHighlighter = Object.freeze(Highlighter);
})(typeof globalThis !== 'undefined' ? globalThis : self);
