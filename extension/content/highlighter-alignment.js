// Pure word-alignment helpers for TTS highlighting (no DOM). Loaded before content-highlighter.js.
(function initLexoraHighlighterAlignment(global) {
  function norm(w) {
    return w.toLowerCase().replace(/[^\w]/g, '');
  }

  function alignChunkToPage(pageWords, chunkWords, startIdx) {
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
        misses++;
        if (misses % 3 === 0) pi++;
      }
    }
    return pairs;
  }

  function findChunkStart(pageWords, wordCursor, chunkWords) {
    if (!chunkWords.length || !pageWords) return -1;
    const normed = chunkWords.map(norm);
    for (let i = wordCursor; i < pageWords.length; i++) {
      if (norm(pageWords[i].word) !== normed[0]) continue;
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

  global.LexoraHighlighterAlignment = Object.freeze({
    norm,
    alignChunkToPage,
    findChunkStart,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
