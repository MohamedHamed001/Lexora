// ── Simple Markdown Parsing ────────────────────────────────────────────────

export function mdToHtml(md) {
  const lines = (md || '').split('\n');
  let html = '', inList = false;

  lines.forEach(raw => {
    const line = raw.trimEnd();
    if (/^#{2,}\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3 class="md-h3">${inlineMd(escHtml(line.replace(/^#{2,}\s+/, '')))}</h3>`;
    } else if (/^#\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h2 class="md-h2">${inlineMd(escHtml(line.replace(/^#\s+/, '')))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul class="md-ul">'; inList = true; }
      html += `<li>${inlineMd(escHtml(line.replace(/^[-*]\s+/, '')))}</li>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div style="height:0.4em"></div>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p class="md-p">${inlineMd(escHtml(line))}</p>`;
    }
  });

  if (inList) html += '</ul>';
  return html;
}

export function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code class="md-code">$1</code>');
}

export function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
