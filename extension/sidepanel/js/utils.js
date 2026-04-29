// ── Safe DOM rendering (no innerHTML) ───────────────────────────────────────

function renderInlineMdTo(parent, text) {
  // Very small inline subset: **bold**, *em*, `code`.
  // Operates on plain text; no HTML parsing.
  const s = String(text ?? '');
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const idx = m.index;
    if (idx > last) parent.appendChild(document.createTextNode(s.slice(last, idx)));
    const token = m[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const el = document.createElement('strong');
      el.textContent = token.slice(2, -2);
      parent.appendChild(el);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const el = document.createElement('em');
      el.textContent = token.slice(1, -1);
      parent.appendChild(el);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const el = document.createElement('code');
      el.className = 'md-code';
      el.textContent = token.slice(1, -1);
      parent.appendChild(el);
    } else {
      parent.appendChild(document.createTextNode(token));
    }
    last = idx + token.length;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
}

export function mdToDomFragment(md) {
  const lines = String(md ?? '').split('\n');
  const frag = document.createDocumentFragment();
  let inList = false;
  let listEl = null;

  const closeList = () => {
    if (inList && listEl) frag.appendChild(listEl);
    inList = false;
    listEl = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (/^#{2,}\s+/.test(line)) {
      closeList();
      const h = document.createElement('h3');
      h.className = 'md-h3';
      renderInlineMdTo(h, line.replace(/^#{2,}\s+/, ''));
      frag.appendChild(h);
    } else if (/^#\s+/.test(line)) {
      closeList();
      const h = document.createElement('h2');
      h.className = 'md-h2';
      renderInlineMdTo(h, line.replace(/^#\s+/, ''));
      frag.appendChild(h);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        inList = true;
        listEl = document.createElement('ul');
        listEl.className = 'md-ul';
      }
      const li = document.createElement('li');
      renderInlineMdTo(li, line.replace(/^[-*]\s+/, ''));
      listEl.appendChild(li);
    } else if (line.trim() === '') {
      closeList();
      const spacer = document.createElement('div');
      spacer.style.height = '0.4em';
      frag.appendChild(spacer);
    } else {
      closeList();
      const p = document.createElement('p');
      p.className = 'md-p';
      renderInlineMdTo(p, line);
      frag.appendChild(p);
    }
  }

  closeList();
  return frag;
}

export function clearMarks(root) {
  if (!root) return;
  const marks = root.querySelectorAll('mark');
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent || ''), m);
    parent.normalize();
  }
}

export function markMatches(root, term) {
  const q = String(term ?? '').trim();
  if (!root || !q) return;
  const query = q.toLowerCase();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('mark,script,style,noscript')) return NodeFilter.FILTER_REJECT;
      const t = node.nodeValue || '';
      return t.toLowerCase().includes(query) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) continue;

    const frag = document.createDocumentFragment();
    let pos = 0;
    let matchIdx = idx;
    while (matchIdx >= 0) {
      if (matchIdx > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, matchIdx)));
      }
      const mark = document.createElement('mark');
      mark.textContent = text.slice(matchIdx, matchIdx + q.length);
      frag.appendChild(mark);
      pos = matchIdx + q.length;
      matchIdx = lower.indexOf(query, pos);
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)));
    }

    node.parentNode.replaceChild(frag, node);
  }
}

// Float32Array → WAV Blob
export function encodeWAV(samples, sampleRate = 24000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeString = (off, s) => { for (let i=0; i<s.length; i++) view.setUint8(off+i, s.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Split text into short chunks for faster synthesis.
 * Targets ~80-150 chars per chunk, breaking at natural pause points.
 */
export function splitIntoChunks(text, maxLen = 120) {
  if (!text || !text.trim()) return [];

  // First split into sentences
  const rawSentences = text.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) || [text];
  const chunks = [];

  for (const sent of rawSentences) {
    const trimmed = sent.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxLen) {
      chunks.push(trimmed);
      continue;
    }

    // Sentence too long, break on commas/semicolons/colons
    const subParts = trimmed.split(/([,;:—]+)/);
    let current = '';

    for (const part of subParts) {
      if (current.length + part.length > maxLen && current.length > 20) {
        if (current.trim()) chunks.push(current.trim());
        current = part;
      } else {
        current += part;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  // Final merge pass: if a chunk is very short, merge with next
  const merged = [];
  let temp = '';
  for (const c of chunks) {
    if (!temp) temp = c;
    else if (temp.length + c.length < maxLen * 0.7) temp += ' ' + c;
    else { merged.push(temp); temp = c; }
  }
  if (temp) merged.push(temp);

  return merged;
}
