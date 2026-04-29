// Shared page extraction/probing helpers for injected extension contexts.
(function initLexoraCaptureExtractor(global) {
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

  function collectHtmlBlocks(doc, seen = new Set()) {
    const allEls = Array.from(doc.querySelectorAll(contentSelectors().join(',')));
    const leafEls = allEls.filter((el) =>
      !allEls.some((other) => other !== el && el.contains(other))
    );

    const blocks = [];
    leafEls.forEach((el) => {
      if (el.closest('nav,button,header,footer,[role="navigation"]')) return;
      const isVisible = !!el.offsetParent;
      const txt = normalizeLine(isVisible ? el.innerText : el.textContent);
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

  function extractPageContent(doc = global.document, loc = global.location) {
    if (!doc || !loc || isRestrictedProtocol(loc.protocol)) return null;

    const seen = new Set();
    const htmlFormatted = formatBlocks(collectHtmlBlocks(doc, seen));
    const pdfText = collectPdfText(doc, seen);
    const content =
      pdfText.length >= 400 && pdfText.length > htmlFormatted.length * 0.8
        ? pdfText
        : htmlFormatted;

    if (!content || content.length < 80) {
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

    const pdfText = collectPdfText(doc);
    const blocks = collectHtmlBlocks(doc);
    let htmlChars = 0;
    for (const block of blocks.slice(0, 250)) {
      htmlChars += block.text.length;
      if (htmlChars > 2500) break;
    }

    const pdfChars = pdfText.length;
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
  }

  global.LexoraCaptureExtractor = Object.freeze({
    normalizeLine,
    extractPageContent,
    probePageContent,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
