// sidepanel.js — popup edition

let currentLesson = null;

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`${id}-panel`).style.display = 'block';
  };
});

// ── Capture button ─────────────────────────────────────────────────────────
const captureBtn    = document.getElementById('capture-btn');
const captureStatus = document.getElementById('capture-status');

captureBtn.addEventListener('click', () => {
  captureBtn.textContent   = '⏳ Scanning…';
  captureBtn.disabled      = true;
  captureStatus.textContent = '';

  chrome.runtime.sendMessage({ action: 'triggerDeepCapture' }, resp => {
    captureBtn.disabled = false;

    if (resp && resp.success) {
      currentLesson = resp.data;
      chrome.storage.local.set({ currentLesson });
      applyLesson(currentLesson);
      captureBtn.textContent    = '✅ Captured';
      captureStatus.textContent = '';
      setTimeout(() => { captureBtn.textContent = '✨ Capture'; }, 2500);
    } else {
      captureBtn.textContent    = '✨ Capture';
      captureStatus.textContent = '⚠️ ' + (resp?.error || 'No content found on this page.');
    }
  });
});

// ── Apply lesson to all tabs ───────────────────────────────────────────────
function applyLesson(lesson) {
  if (!lesson) return;

  // Header
  const urlEl = document.getElementById('lesson-url');
  const titleEl = document.getElementById('lesson-title');
  const lessonHeader = document.getElementById('lesson-header');

  if (urlEl) {
    try { urlEl.textContent = new URL(lesson.url).hostname; }
    catch (_) { urlEl.textContent = lesson.url || ''; }
  }
  if (titleEl) titleEl.textContent = lesson.title || 'Unnamed';
  if (lessonHeader) lessonHeader.style.display = 'block';

  // Content tab
  document.getElementById('lesson-text').innerHTML = mdToHtml(lesson.content || '');

  // Export tab
  const info = document.getElementById('export-info');
  if (info) info.textContent = `📖 "${lesson.title}" — ready to export.`;

  // Reset chat
  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = `<div class="ai-bubble">✅ Captured <strong>${escHtml(lesson.title)}</strong>. Ask me anything!</div>`;
}

// ── Markdown → HTML ────────────────────────────────────────────────────────
function mdToHtml(md) {
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

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code class="md-code">$1</code>');
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── AI Chat ────────────────────────────────────────────────────────────────
document.getElementById('chat-input').addEventListener('keypress', e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const q = e.target.value.trim();
  e.target.value = '';

  addBubble('user', q);
  if (!currentLesson) { addBubble('ai', '❌ Please capture a page first!'); return; }

  const thinking = addBubble('ai', '…');
  chrome.runtime.sendMessage({
    action: 'proxyFetch',
    url:    'http://127.0.0.1:1234/v1/chat/completions',
    method: 'POST',
    body: {
      model: 'local-model',
      messages: [
        { role: 'system', content: `You are a concise study assistant. Answer based on this lesson:\n\nTitle: ${currentLesson.title}\n\n${currentLesson.content}` },
        { role: 'user', content: q },
      ],
      temperature: 0.7,
    },
  }, resp => {
    if (resp?.success) {
      thinking.innerHTML = mdToHtml(resp.data.choices[0].message.content);
    } else {
      thinking.innerText = '❌ Could not reach LM Studio at 127.0.0.1:1234.';
    }
    document.getElementById('content-container').scrollTop = 99999;
  });
});

function addBubble(role, text) {
  const box = document.getElementById('chat-messages');
  const el  = document.createElement('div');
  el.className = role === 'user' ? 'user-bubble' : 'ai-bubble';
  el.innerText  = text;
  box.appendChild(el);
  document.getElementById('content-container').scrollTop = 99999;
  return el;
}

// ── TTS — Google US English only ──────────────────────────────────────────
const synth = window.speechSynthesis;
let speaking = false;
let sentences = [], sentenceIdx = 0;
let googleVoice = null;

const rateSlider  = document.getElementById('rate-slider');
const rateLabel   = document.getElementById('rate-label');
const playBtn     = document.getElementById('play-btn');
const voiceStatus = document.getElementById('voice-status');

rateSlider.addEventListener('input', () => {
  rateLabel.textContent = parseFloat(rateSlider.value).toFixed(2) + '×';
});

function findGoogleVoice() {
  const all = synth.getVoices();
  // Try exact match first, then any Google en-US
  return all.find(v => v.name === 'Google US English')
      || all.find(v => v.name.startsWith('Google') && v.lang.startsWith('en-US'))
      || all.find(v => v.lang.startsWith('en-US'))
      || all.find(v => v.lang.startsWith('en'))
      || all[0]
      || null;
}

function initVoice(tries = 0) {
  googleVoice = findGoogleVoice();
  if (googleVoice) {
    voiceStatus.textContent = `🎙 ${googleVoice.name}`;
  } else if (tries < 40) {
    setTimeout(() => initVoice(tries + 1), 250);
  }
}
initVoice();

playBtn.addEventListener('click', () => {
  if (!currentLesson) return;

  if (speaking) {
    synth.cancel();
    speaking = false;
    playBtn.textContent = '▶ Play Narration';
    document.getElementById('waveform-progress').style.width = '0%';
    return;
  }

  if (!googleVoice) googleVoice = findGoogleVoice();

  const plain = (currentLesson.content || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^[-*]\s+/gm, '');

  sentences    = plain.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) || [plain];
  sentenceIdx  = 0;
  speaking     = true;
  playBtn.textContent = '⏹ Stop';
  speakNext();
});

function speakNext() {
  if (!speaking || sentenceIdx >= sentences.length) {
    speaking = false;
    playBtn.textContent = '▶ Play Narration';
    document.getElementById('waveform-progress').style.width = '100%';
    return;
  }
  const utt = new SpeechSynthesisUtterance(sentences[sentenceIdx].trim());
  if (googleVoice) utt.voice = googleVoice;
  utt.rate  = parseFloat(rateSlider.value);
  utt.pitch = 1.0;
  utt.onend = utt.onerror = () => {
    sentenceIdx++;
    const pct = Math.round((sentenceIdx / sentences.length) * 100);
    document.getElementById('waveform-progress').style.width = pct + '%';
    speakNext();
  };
  synth.speak(utt);
}

// ── PDF Export ─────────────────────────────────────────────────────────────
document.getElementById('export-pdf').addEventListener('click', () => {
  if (!currentLesson) { alert('Capture a page first!'); return; }

  let JsPDF;
  try { JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF; } catch (_) {}
  if (!JsPDF) { alert('PDF library not available. Reload and try again.'); return; }

  try {
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M  = 14, CW = PW - M * 2;
    let y    = M + 4;

    // Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(20, 20, 20);
    doc.splitTextToSize(pdfClean(currentLesson.title), CW).forEach(line => {
      if (y > PH - M) { doc.addPage(); y = M + 4; }
      doc.text(line, M, y);
      y += 9;
    });

    // Source URL
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(pdfClean(currentLesson.url || ''), M, y);
    y += 5;
    doc.setDrawColor(200, 200, 210);
    doc.line(M, y, PW - M, y);
    y += 6;

    // Body
    const body = (currentLesson.content || '')
      .replace(/^#{1,6}\s+(.+)$/gm, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^[-*]\s+/gm, '• ');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(45, 45, 45);
    doc.splitTextToSize(pdfClean(body), CW).forEach(line => {
      if (y + 7 > PH - M - 5) {
        doc.addPage();
        y = M + 4;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(45, 45, 45);
      }
      doc.text(line, M, y);
      y += 6.5;
    });

    // Page footers
    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setTextColor(170, 170, 170);
      doc.text(`AI-Study Companion  •  Page ${p} of ${total}`, M, PH - 6);
    }

    doc.save(`${pdfClean(currentLesson.title).slice(0, 50) || 'Lesson'}.pdf`);
  } catch (err) {
    console.error('PDF error:', err);
    alert('PDF export failed: ' + err.message);
  }
});

function pdfClean(str) {
  return (str || '').replace(/[^\x09\x0A\x0D\x20-\xFF]/g, ' ').replace(/\r/g, '').trim();
}

// ── Load persisted lesson ──────────────────────────────────────────────────
chrome.storage.local.get(['currentLesson'], res => {
  if (res.currentLesson) {
    currentLesson = res.currentLesson;
    applyLesson(currentLesson);
  }
});
