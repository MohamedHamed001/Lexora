// Shared page extraction/probing helpers for injected extension contexts.
(function initLexoraCaptureExtractor(global) {
  const MINL =
    (global.LexoraConstants && global.LexoraConstants.MIN_CAPTURE_CONTENT_CHARS) || 80;
  const LIMITS = Object.freeze({
    /** Aligned with LexoraConstants / background “best frame” lesson threshold. */
    MIN_LESSON_CONTENT_CHARS: MINL,
    /** Probe caps work for very large pages; scoring uses the same formatter as extract. */
    PROBE_BLOCK_CAP: 250,
    /** HTML vs PDF readiness thresholds (chars after formatting / collection). */
    HTML_READY_CHARS: 800,
    PDF_READY_CHARS: 400,
  });

  function normalizeLine(s) {
    return (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isRestrictedProtocol(protocol) {
    return (
      protocol === 'chrome-extension:' ||
      protocol === 'moz-extension:' ||
      protocol === 'webkit-extension:' ||
      protocol === 'chrome-search:'
    );
  }

  function contentSelectors() {
    return [
      'article', 'main', '[role="main"]',
      'section > p', 'section > h1', 'section > h2', 'section > h3', 'section > h4',
      'h1', 'h2', 'h3', 'h4',
      'p', 'li',
      'blockquote',
      'pre', 'code',
    ];
  }

  function isElementVisible(el) {
    // The original code used `!!el.offsetParent`, which is unreliable for
    // `position: fixed`, modern flex/grid layouts, and test environments
    // where layout isn't computed (JSDOM). The audit asked us to replace it.
    //
    // Strategy: default to "visible" and only filter out elements we are
    // *confident* are hidden, by checking computed style. This avoids
    // dropping legitimate content in edge layouts.
    if (!el || typeof window === 'undefined' || !window.getComputedStyle) return true;
    try {
      const cs = window.getComputedStyle(el);
      if (!cs) return true;
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  function collectHtmlBlocks(doc, seen = new Set()) {
    const allEls = Array.from(doc.querySelectorAll(contentSelectors().join(',')));

    // Single ancestor walk per element to identify "leaf" matches whose
    // ancestors are also matches — we keep the leaves to avoid duplicating
    // text that would appear from both a container (e.g. <article>) and its
    // children (e.g. <p>). This is O(n*depth), not O(n^2).
    const allElsSet = new Set(allEls);
    const hasDescendant = new Set();
    for (let i = allEls.length - 1; i >= 0; i--) {
      let parent = allEls[i].parentElement;
      while (parent) {
        if (allElsSet.has(parent)) {
          hasDescendant.add(parent);
          break;
        }
        parent = parent.parentElement;
      }
    }
    const leafEls = allEls.filter(el => !hasDescendant.has(el));

    const blocks = [];
    leafEls.forEach((el) => {
      if (el.closest('nav,button,header,footer,[role="navigation"]')) return;
      if (!isElementVisible(el)) return;
      // Prefer innerText when it has visible text; otherwise textContent (CI
      // headless/Xvfb often yields "" innerText before layout is fully applied).
      const inner = typeof el.innerText === 'string' ? el.innerText : '';
      const fallback = el.textContent || '';
      const rawText = inner.replace(/\s/g, '').length > 0 ? inner : fallback;
      const txt = normalizeLine(rawText);
      if (txt.length > 10 && !seen.has(txt)) {
        seen.add(txt);
        blocks.push({ tag: el.tagName, text: txt });
      }
    });
    return blocks;
  }

  function formatBlocks(blocks) {
    return blocks.map((b) =>
      /^H\d$/.test(b.tag) ? `\n## ${b.text}\n` : b.text
    ).join('\n\n').trim();
  }

  function collectPdfText(doc, seen = new Set()) {
    const pdfTextNodes = [
      ...doc.querySelectorAll(
        '.textLayer span, [class*="textLayer"] span, .textLayer div, [class*="textLayer"] div'
      ),
    ];

    const pdfLines = [];
    for (const node of pdfTextNodes) {
      const t = normalizeLine(node.textContent);
      if (t.length > 2 && !seen.has(t)) {
        seen.add(t);
        pdfLines.push(t);
      }
    }
    return pdfLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function findPdfUrl(doc) {
    const pdfEmbeds = [
      ...doc.querySelectorAll(
        'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], iframe[src*="viewer"], iframe[src*="pdf"]'
      ),
    ];
    const srcEl = pdfEmbeds.find((e) => e && (e.src || e.data));
    return srcEl ? (srcEl.src || srcEl.data || '') : '';
  }

  function titleFromDocument(doc) {
    return doc.title.split(' - ')[0] || doc.title || 'Captured Page';
  }

  function scoreContent({ htmlChars, pdfChars }) {
    const { PDF_READY_CHARS, HTML_READY_CHARS } = LIMITS;
    const isPdfDominant = pdfChars >= PDF_READY_CHARS && pdfChars > htmlChars * 0.8;
    const capturable = isPdfDominant ? pdfChars >= PDF_READY_CHARS : htmlChars >= HTML_READY_CHARS;
    const kind = isPdfDominant ? 'pdf' : htmlChars >= HTML_READY_CHARS ? 'html' : 'unknown';

    return {
      capturable,
      status: capturable ? 'ready' : 'not_ready',
      kind,
      reason: capturable ? 'Ready to capture.' : 'No strong text signal found yet (page may still be loading).',
    };
  }

  function extractPageContent(doc = global.document, loc = global.location) {
    if (!doc || !loc || isRestrictedProtocol(loc.protocol)) return null;

    const seen = new Set();
    const htmlFormatted = formatBlocks(collectHtmlBlocks(doc, seen));
    const pdfText = collectPdfText(doc, seen);
    
    const htmlChars = htmlFormatted.length;
    const pdfChars = pdfText.length;
    const score = scoreContent({ htmlChars, pdfChars });
    
    const content = score.kind === 'pdf' ? pdfText : htmlFormatted;

    if (!score.capturable || !content || content.length < LIMITS.MIN_LESSON_CONTENT_CHARS) {
      const pdfUrl = findPdfUrl(doc);
      if (!pdfUrl) return null;
      return {
        title: titleFromDocument(doc),
        content: `## PDF detected\n\nThis page appears to embed a PDF, but no selectable text layer was found to extract from.\n\nPDF URL: ${pdfUrl}`.trim(),
        url: loc.href,
      };
    }

    return {
      title: titleFromDocument(doc),
      content,
      url: loc.href,
    };
  }

  function probePageContent(doc = global.document, loc = global.location) {
    if (!doc || !loc || isRestrictedProtocol(loc.protocol)) {
      return { capturable: false, status: 'restricted', reason: 'Extension pages are not capturable.' };
    }

    // Same `seen` semantics as extractPageContent so probe/extract agree on dedup
    // between HTML blocks and PDF text layers.
    const seen = new Set();
    const blocks = collectHtmlBlocks(doc, seen);
    const pdfText = collectPdfText(doc, seen);
    const probedBlocks =
      blocks.length > LIMITS.PROBE_BLOCK_CAP ? blocks.slice(0, LIMITS.PROBE_BLOCK_CAP) : blocks;
    const htmlChars = formatBlocks(probedBlocks).length;
    const pdfChars = pdfText.length;
    const score = scoreContent({ htmlChars, pdfChars });

    return {
      ...score,
      pdfChars,
      htmlChars,
    };
  }

  global.LexoraCaptureExtractor = Object.freeze({
    LIMITS,
    normalizeLine,
    extractPageContent,
    probePageContent,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
