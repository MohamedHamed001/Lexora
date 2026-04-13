// sidepanel.js — Lexora Neural Edition
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

let currentLesson = null;
let config = {
  url: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'local-model',
  key: '',
  ttsKey: ''
};

// ── Debug Console ──────────────────────────────────────────────────────────
const debugConsole = document.getElementById('debug-console');
const debugLogLines = document.getElementById('debug-log-lines');

function logDebug(msg, type = 'info') {
  // Debug console is hidden from UI as requested
  if (debugConsole) debugConsole.style.display = 'none';
  const line = document.createElement('div');
  line.style.marginBottom = '2px';
  line.style.color = type === 'error' ? '#f87171' : (type === 'warn' ? '#fbbf24' : '#86efac');
  line.textContent = `[${new Date().toLocaleTimeString([], {hour12:false})}] ${msg}`;
  debugLogLines.appendChild(line);
  debugLogLines.parentElement.scrollTop = debugLogLines.parentElement.scrollHeight;
  console.log(`[Neural Debug] ${msg}`);
}

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
const popOutBtn     = document.getElementById('pop-out-btn');

if (popOutBtn) {
  // Hide the pop-out button if we are already in the overlay iframe
  if (window.parent !== window) {
    popOutBtn.style.display = 'none';
  }

  popOutBtn.addEventListener('click', () => {
    browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        // Toggle the draggable overlay in the active tab
        browserAPI.tabs.sendMessage(tabs[0].id, { action: 'toggleOverlay' });
        // Close the popup window
        window.close();
      }
    });
  });
}

captureBtn.addEventListener('click', () => {
  captureBtn.textContent   = '⏳ Scanning…';
  captureBtn.disabled      = true;
  captureStatus.textContent = '';

  browserAPI.runtime.sendMessage({ action: 'triggerDeepCapture' }, resp => {
    captureBtn.disabled = false;

    if (resp && resp.success) {
      currentLesson = resp.data;
      browserAPI.storage.local.set({ currentLesson });
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

  const urlEl = document.getElementById('lesson-url');
  const titleEl = document.getElementById('lesson-title');
  const lessonHeader = document.getElementById('lesson-header');

  if (urlEl) {
    try { urlEl.textContent = new URL(lesson.url).hostname; }
    catch (_) { urlEl.textContent = lesson.url || ''; }
  }
  if (titleEl) titleEl.textContent = lesson.title || 'Unnamed';
  if (lessonHeader) lessonHeader.style.display = 'block';

  document.getElementById('lesson-text').innerHTML = mdToHtml(lesson.content || '');

  const info = document.getElementById('export-info');
  if (info) info.textContent = `📖 "${lesson.title}" — ready to export.`;

  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = `<div class="ai-bubble">✅ Captured <strong>${escHtml(lesson.title)}</strong>. Ask me anything!</div>`;
}

// ── Simple Markdown Parsing ────────────────────────────────────────────────
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

  const headers = { 'Content-Type': 'application/json' };
  if (config.key) headers['Authorization'] = `Bearer ${config.key}`;

  const thinking = addBubble('ai', '…');
  browserAPI.runtime.sendMessage({
    action: 'proxyFetch',
    url:    config.url,
    method: 'POST',
    headers: headers,
    body: {
      model: config.model,
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
      thinking.innerText = `❌ Error: ${resp?.error || 'Could not reach API.'}`;
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

// ── Audio Engine ───────────────────────────────────────────────────────────
const synth = window.speechSynthesis;
let speaking = false;
let isPaused = false;
let sentences = [], sentenceIdx = 0;
let googleVoice = null;

// Helper: Float32Array to WAV Blob
function encodeWAV(samples, sampleRate = 16000) {
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

const rateSlider  = document.getElementById('rate-slider');
const rateLabel   = document.getElementById('rate-label');
const playBtn     = document.getElementById('play-btn');
const prevBtn     = document.getElementById('prev-btn');
const nextBtn     = document.getElementById('next-btn');
const voicePicker = document.getElementById('voice-picker');
const seekBar     = document.getElementById('seek-bar');
const statusLabel = document.getElementById('status-label');

let currentAudioElement = null;
let seekerTimer = null;
const openAIVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
let neuralWorker = null;
let neuralModelLoaded = false;
let audioCtx = null;
let currentSynthesisId = 0; // Prevent overlapping audio results

rateSlider.addEventListener('input', () => {
  const val = parseFloat(rateSlider.value);
  rateLabel.textContent = val.toFixed(2) + '×';
  if (currentAudioElement) {
    currentAudioElement.playbackRate = val;
  }
});

// ── Smooth Seeker Updates ──────────────────────────────────────────────────
function startSeekerTimer() {
  stopSeekerTimer();
  seekerTimer = setInterval(updateSeekBar, 100);
}
function stopSeekerTimer() {
  if (seekerTimer) clearInterval(seekerTimer);
  seekerTimer = null;
}
function updateSeekBar() {
  if (!sentences.length || !currentAudioElement) return;
  
  // Progress = (currentSentenceIndex + (itemProgress)) / totalSentences
  // itemProgress = audio.currentTime / audio.duration
  let itemProgress = 0;
  if (currentAudioElement.duration) {
    itemProgress = currentAudioElement.currentTime / currentAudioElement.duration;
  }
  
  const total = sentences.length;
  const progress = ((sentenceIdx + itemProgress) / total) * 100;
  seekBar.value = progress;
}

// ── Voice Discovery Logic (Siri Fix) ────────────────────────────────────────
function findGoogleVoice() {
  const all = synth.getVoices();
  return all.find(v => v.name.includes('Siri') && v.name.includes('4'))
      || all.find(v => v.name.includes('Natural'))
      || all.find(v => v.name === 'Google US English')
      || all.find(v => v.name.includes('Premium') && v.lang.startsWith('en'))
      || all.find(v => v.name.includes('Enhanced') && v.lang.startsWith('en'))
      || all.find(v => v.lang.startsWith('en-US'))
      || all.find(v => v.lang.startsWith('en'))
      || all[0] || null;
}

async function initVoice(tries = 0) {
  if (config.ttsKey) {
    voicePicker.innerHTML = '';
    openAIVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = `OpenAI: ${v.charAt(0).toUpperCase() + v.slice(1)}`;
      voicePicker.appendChild(opt);
    });
    return;
  }

  const all = synth.getVoices();
  if (all.length > 0) {
    const sorted = [...all].sort((a, b) => {
      const rank = (v) => {
        if (v.name.includes('Siri')) return 3;
        if (v.name.includes('Natural')) return 2;
        if (v.name.includes('Premium') || v.name.includes('Enhanced')) return 1;
        return 0;
      };
      if (a.lang.startsWith('en') && !b.lang.startsWith('en')) return -1;
      if (!a.lang.startsWith('en') && b.lang.startsWith('en')) return 1;
      return rank(b) - rank(a);
    });

    voicePicker.innerHTML = '';
    
    // 1. Lexora Premium (Piper)
    const neuralOpt = document.createElement('option');
    neuralOpt.value = 'lexora-neural';
    neuralOpt.textContent = '✨ Lexora Premium (Amy)';
    voicePicker.appendChild(neuralOpt);

    // 2. Search for specialized voices
    const siri = all.find(v => v.name.includes('Siri'));
    const googleUS = all.find(v => v.name === 'Google US English');
    
    if (googleUS) {
      const opt = document.createElement('option');
      opt.value = all.indexOf(googleUS);
      opt.textContent = 'Google US English';
      voicePicker.appendChild(opt);
    }
    
    if (siri) {
      const opt = document.createElement('option');
      opt.value = all.indexOf(siri);
      opt.textContent = 'Siri (System Default)';
      voicePicker.appendChild(opt);
    }

    // Default selection
    voicePicker.selectedIndex = 0;
  } else if (tries < 40) {
    setTimeout(() => initVoice(tries + 1), 250);
  }
}

async function loadNeuralModel() {
  if (neuralModelLoaded) return true;
  statusLabel.textContent = '🧠 Loading Lexora Neural Engine...';
  logDebug('Loading Neural Model...');
  
  try {
    const modelUrl = browserAPI.runtime.getURL('sidepanel/amy-low.onnx');
    const configUrl = browserAPI.runtime.getURL('sidepanel/amy-low.onnx.json');
    
    logDebug('Fetching model and config assets...');
    const [modelResp, configResp] = await Promise.all([
      fetch(modelUrl),
      fetch(configUrl)
    ]);
    
    if (!modelResp.ok || !configResp.ok) throw new Error('Failed to fetch model files. Check manifest web_accessible_resources.');

    const modelBuffer = await modelResp.arrayBuffer();
    const configJson = await configResp.text();
    
    logDebug(`Assets loaded. Model size: ${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);
    
    neuralWorker = new Worker(browserAPI.runtime.getURL('sidepanel/piper-worker.js'));
    
    return new Promise((resolve, reject) => {
      neuralWorker.onmessage = (e) => {
        if (e.data.type === 'initialized') {
          neuralModelLoaded = true;
          statusLabel.textContent = '';
          logDebug('Worker Initialized Successfully.');
          resolve(true);
        } else if (e.data.type === 'log') {
          logDebug(`Worker: ${e.data.message}`);
        } else if (e.data.type === 'error') {
          logDebug(`Worker Error: ${e.data.error}`, 'error');
          statusLabel.textContent = '❌ ' + e.data.error;
          reject(e.data.error);
        }
      };
      neuralWorker.postMessage({ type: 'init', model: modelBuffer, config: configJson }, [modelBuffer]);
    });
  } catch (e) {
    logDebug(`Neural Load Error: ${e.message}`, 'error');
    console.error('Neural Load Error:', e);
    statusLabel.textContent = '❌ Failed to load Neural Engine.';
    return false;
  }
}

function cancelAudio() {
  currentSynthesisId++; // Ignore any pending neural results
  stopSeekerTimer();
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      if (currentAudioElement.src) URL.revokeObjectURL(currentAudioElement.src);
    } catch(e) {}
    currentAudioElement = null;
  }
  synth.cancel();
}

voicePicker.addEventListener('change', () => {
  if (!config.ttsKey && voicePicker.value !== 'lexora-neural') {
    googleVoice = synth.getVoices().find(v => v.name === voicePicker.options[voicePicker.selectedIndex].textContent.split(' (')[0]);
  } else {
    googleVoice = null;
  }
});

let seekDebounce = null;
seekBar.addEventListener('input', () => {
  if (sentences.length === 0) return;
  
  const pct = parseFloat(seekBar.value);
  const floatIdx = (pct / 100) * sentences.length;
  const newIdx = Math.floor(floatIdx);
  
  // If we are just sliding within the SAME sentence that's currently playing,
  // we can jump the time without re-synthesizing if it's a browser-supported voice.
  if (newIdx === sentenceIdx && currentAudioElement && !isPaused) {
    if (currentAudioElement.duration) {
      const subProgress = floatIdx - newIdx;
      currentAudioElement.currentTime = subProgress * currentAudioElement.duration;
      return;
    }
  }

  // If we jump to a DIFFERENT sentence or need to re-synth, debounce it
  if (seekDebounce) clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    cancelAudio();
    sentenceIdx = Math.min(sentences.length - 1, newIdx);
    if (speaking || isPaused) {
      isPaused = false;
      speaking = true;
      playBtn.textContent = '⏸ Pause';
      speakNext();
    }
  }, 150);
});

prevBtn.addEventListener('click', () => {
  if (sentences.length === 0) return;
  cancelAudio();
  sentenceIdx = Math.max(0, sentenceIdx - 1);
  if (speaking) {
    isPaused = false;
    speakNext();
  }
});

nextBtn.addEventListener('click', () => {
  if (sentences.length === 0) return;
  cancelAudio();
  sentenceIdx = Math.min(sentences.length - 1, sentenceIdx + 1);
  if (speaking) {
    isPaused = false;
    speakNext();
  }
});

playBtn.addEventListener('click', async () => {
  if (!currentLesson) return;

  if (speaking) {
    // Current state is Playing -> Transition to Paused
    if (currentAudioElement) currentAudioElement.pause();
    speaking = false;
    isPaused = true;
    playBtn.textContent = '▶ Resume';
    stopSeekerTimer();
    return;
  }

  if (isPaused) {
    // Current state is Paused -> Transition to Playing
    if (currentAudioElement) {
      await currentAudioElement.play();
      speaking = true;
      isPaused = false;
      playBtn.textContent = '⏸ Pause';
      startSeekerTimer();
      return;
    }
  }

  // Otherwise, start from scratch or current sentenceIdx
  speaking = true;
  isPaused = false;
  playBtn.textContent = '⏸ Pause';
  
  if (sentences.length === 0) {
    const plain = (currentLesson.content || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^[-*]\s+/gm, '');
    sentences = plain.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) || [plain];
  }
  speakNext();
});

async function speakNext() {
  if (!speaking || sentenceIdx >= sentences.length) {
    speaking = false;
    playBtn.textContent = '▶ Play';
    seekBar.value = 100;
    statusLabel.textContent = '';
    return;
  }
  
  const pct = Math.round((sentenceIdx / sentences.length) * 100);
  seekBar.value = pct;
  
  const text = sentences[sentenceIdx].trim();
  const selectedVoiceValue = voicePicker.options[voicePicker.selectedIndex]?.value;

  if (selectedVoiceValue === 'lexora-neural') {
    const ok = await loadNeuralModel();
    if (!ok) return;

    const requestId = ++currentSynthesisId;
    neuralWorker.onmessage = (e) => {
      // Ignore results from previous/cancelled requests
      if (e.data.requestId && e.data.requestId !== currentSynthesisId) {
        logDebug(`Ignoring stale task ${e.data.requestId} (current: ${currentSynthesisId})`);
        return;
      }

      if (e.data.type === 'audio') {
        const blob = encodeWAV(e.data.data, 16000);
        const url  = URL.createObjectURL(blob);
        
        currentAudioElement = new Audio(url);
        currentAudioElement.playbackRate = parseFloat(rateSlider.value);
        currentAudioElement.preservesPitch = true;
        
        currentAudioElement.onended = () => {
          URL.revokeObjectURL(url);
          currentAudioElement = null;
          if (speaking) {
            sentenceIdx++;
            speakNext();
          } else {
            stopSeekerTimer();
          }
        };
        
        if (speaking) {
          currentAudioElement.play();
          startSeekerTimer();
        }
      } else if (e.data.type === 'log') {
        // No-op
      } else if (e.data.type === 'error') {
        logDebug(`Synthesis Error: ${e.data.error}`, 'error');
        if (requestId === currentSynthesisId) {
          sentenceIdx++;
          speakNext();
        }
      }
    };
    neuralWorker.postMessage({ type: 'synthesize', text: text, requestId: requestId });

  } else if (config.ttsKey) {
    // OpenAI TTS
    const voice = selectedVoiceValue || 'alloy';
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ttsKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'tts-1', voice: voice, input: text })
      });
      if (!resp.ok) throw new Error('API failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      currentAudioElement = new Audio(url);
      currentAudioElement.playbackRate = parseFloat(rateSlider.value);
      currentAudioElement.preservesPitch = true;
      currentAudioElement.onended = () => {
        URL.revokeObjectURL(url);
        currentAudioElement = null;
        if (speaking) {
          sentenceIdx++;
          speakNext();
        } else {
          stopSeekerTimer();
        }
      };
      if (speaking) {
        currentAudioElement.play();
        startSeekerTimer();
      }
    } catch (e) {
      speaking = false;
      playBtn.textContent = '▶ Play';
    }
  } else {
    // Native Speech
    const utt = new SpeechSynthesisUtterance(text);
    if (googleVoice) utt.voice = googleVoice;
    utt.rate  = parseFloat(rateSlider.value);
    utt.onstart = () => { startSeekerTimer(); };
    utt.onend = utt.onerror = () => {
      sentenceIdx++;
      speakNext();
    };
    synth.speak(utt);
    currentAudioElement = { playbackRate: 1.0, duration: text.length, currentTime: 0 }; // Mock for seeker
  }
}

// ── PDF Export ─────────────────────────────────────────────────────────────
document.getElementById('export-pdf').addEventListener('click', () => {
  if (!currentLesson) return;
  const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if (!JsPDF) return;
  try {
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M  = 14, CW = PW - M * 2;
    let y    = M + 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.splitTextToSize(currentLesson.title, CW).forEach(line => {
      if (y > PH - M) { doc.addPage(); y = M + 4; }
      doc.text(line, M, y);
      y += 9;
    });
    doc.setFontSize(8);
    doc.text(currentLesson.url || '', M, y);
    y += 10;
    const body = (currentLesson.content || '').replace(/^#{1,6}\s+/gm, '');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.splitTextToSize(body, CW).forEach(line => {
      if (y > PH - M - 10) { doc.addPage(); y = M + 4; }
      doc.text(line, M, y);
      y += 6.5;
    });
    doc.save(`${currentLesson.title.slice(0, 30)}.pdf`);
  } catch (err) { console.error(err); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
browserAPI.storage.local.get(['currentLesson', 'lexoraConfig'], res => {
  if (res.currentLesson) {
    currentLesson = res.currentLesson;
    applyLesson(currentLesson);
  }
  if (res.lexoraConfig) {
    config = { ...config, ...res.lexoraConfig };
  }
  document.getElementById('setting-url').value = config.url || '';
  document.getElementById('setting-model').value = config.model || '';
  document.getElementById('setting-key').value = config.key || '';
  document.getElementById('setting-tts-key').value = config.ttsKey || '';
  initVoice();
});

document.getElementById('save-settings-btn').addEventListener('click', () => {
  config.url = document.getElementById('setting-url').value.trim();
  config.model = document.getElementById('setting-model').value.trim();
  config.key = document.getElementById('setting-key').value.trim();
  config.ttsKey = document.getElementById('setting-tts-key').value.trim();
  browserAPI.storage.local.set({ lexoraConfig: config }, () => {
    const status = document.getElementById('settings-status');
    status.textContent = '✅ Config Saved';
    initVoice();
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
