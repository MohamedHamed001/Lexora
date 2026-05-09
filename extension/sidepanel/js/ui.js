import { state } from './state.js';
import { dom } from './dom.js';
import { mdToDomFragment, clearMarks, markMatches } from './utils.js';

const A = (globalThis.LexoraProtocol && LexoraProtocol.ACTIONS) || null;
const K = (globalThis.LexoraStorage && LexoraStorage.KEYS) || {
  CURRENT_LESSON: 'currentLesson',
  AUTO_PLAY_SELECTED_TEXT: 'autoPlaySelectedText',
};

let audioCtrl = null;

function showNoSupportedContent(message) {
  const msg = (message || 'No content found on this page.').trim();

  if (dom.lessonHeader) dom.lessonHeader.style.display = 'none';
  if (dom.titleEl) dom.titleEl.textContent = '';

  if (dom.lessonText) {
    const card = document.createElement('div');
    card.className = 'no-content-card';
    const title = document.createElement('div');
    title.className = 'no-content-title';
    title.textContent = 'No supported content detected';
    const body = document.createElement('div');
    body.className = 'no-content-body';
    body.textContent = msg + '\n\nIf you’re sure the page contains readable content, wait a moment (large files can take time), then refresh once and try capturing again.';
    card.appendChild(title);
    card.appendChild(body);
    dom.lessonText.replaceChildren(card);
  }

  if (dom.exportInfo) {
    dom.exportInfo.textContent = 'No lesson captured yet.';
  }

  if (dom.chatMessages) {
    const b = document.createElement('div');
    b.className = 'ai-bubble';
    b.textContent = `⚠️ ${msg}\n\nTry capturing again after the page finishes loading.`;
    dom.chatMessages.replaceChildren(b);
    state.chatHistory = [];
  }

  const contentTab = document.querySelector('.tab[data-tab="content"]');
  if (contentTab) contentTab.click();
}

export function initUI({ audio }) {
  audioCtrl = audio;
  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const id = tab.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById(`${id}-panel`);
      if (panel) panel.style.display = id === 'chat' ? 'flex' : 'block';
    };
  });

  // ── Capture button ─────────────────────────────────────────────────────────
  if (dom.captureBtn) {
    dom.captureBtn.addEventListener('click', () => {
      dom.captureBtn.textContent   = '⏳ Scanning…';
      dom.captureBtn.disabled      = true;
      if (dom.captureStatus) dom.captureStatus.textContent = '';

      state.browserAPI.runtime.sendMessage({ action: A ? A.TRIGGER_DEEP_CAPTURE : 'triggerDeepCapture' }, (resp) => {
        dom.captureBtn.disabled = false;

        if (resp && resp.success) {
          state.currentLesson = resp.data;
          state.browserAPI.storage.local.set({ [K.CURRENT_LESSON]: state.currentLesson });
          applyLesson(state.currentLesson);

          dom.captureBtn.textContent = '✅ Captured';
          if (dom.captureStatus) dom.captureStatus.textContent = '';
          setTimeout(() => { dom.captureBtn.textContent = '✨ Capture'; }, 2500);
        } else {
          dom.captureBtn.textContent = '✨ Capture';
          if (dom.captureStatus) {
            dom.captureStatus.textContent = '⚠️ ' + (resp?.error || 'No content found on this page.');
          }
          showNoSupportedContent(resp?.error || 'No content found on this page.');
        }
      });
    });
  }

  // ── Capture readiness indicator ───────────────────────────────────────────
  let _lastReadyStatus = null;
  let _lastReadyReason = null;
  let _probeInFlight = false;

  let setReady = ({ status, reason }) => {
    if (!dom.captureReady) return;

    // Avoid repainting the badge if nothing actually changed.
    const nextStatus = status || 'unknown';
    const nextReason = reason || '';
    if (_lastReadyStatus === nextStatus && _lastReadyReason === nextReason) return;
    _lastReadyStatus = nextStatus;
    _lastReadyReason = nextReason;

    dom.captureReady.classList.remove(
      'capture-ready--unknown',
      'capture-ready--ready',
      'capture-ready--not_ready',
      'capture-ready--restricted'
    );

    const s = nextStatus;
    const mapClass =
      s === 'ready' ? 'capture-ready--ready'
      : s === 'restricted' ? 'capture-ready--restricted'
      : s === 'not_ready' ? 'capture-ready--not_ready'
      : 'capture-ready--unknown';

    dom.captureReady.classList.add(mapClass);
    const textEl = dom.captureReady.querySelector('.capture-ready-text');
    if (textEl) {
      textEl.textContent =
        s === 'ready' ? 'Ready'
        : s === 'restricted' ? 'Blocked'
        : s === 'not_ready' ? 'Not ready'
        : 'Checking';
    }
    dom.captureReady.title = nextReason || 'Checking page…';
  };

  async function probeCapturableOnce() {
    if (_probeInFlight) return;
    _probeInFlight = true;

    // Don't flicker "Ready" → "Checking" just because we're refreshing in the background.
    if (_lastReadyStatus !== 'ready') {
      setReady({ status: 'unknown', reason: 'Checking page…' });
    }
    try {
      // Support both callback-style (chrome) and promise-style (browser) APIs.
      const maybePromise = state.browserAPI.runtime.sendMessage({ action: A ? A.PROBE_CAPTURABLE : 'probeCapturable' }, (resp) => {
        _probeInFlight = false;
        if (resp?.success) setReady({ status: resp.status, reason: resp.reason });
        else setReady({ status: 'unknown', reason: resp?.error || 'Checking page…' });
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        const resp = await maybePromise;
        _probeInFlight = false;
        if (resp?.success) setReady({ status: resp.status, reason: resp.reason });
        else setReady({ status: 'unknown', reason: resp?.error || 'Checking page…' });
      }
    } catch (e) {
      _probeInFlight = false;
      setReady({ status: 'restricted', reason: e?.message || 'This page blocks extraction.' });
    }
  }

  // Kick off immediately, then refresh until stable (captures SPA/PDF viewer readiness).
  probeCapturableOnce();
  let probeInterval = null;
  let stableReadyCount = 0;
  const startProbeLoop = () => {
    if (probeInterval) return;
    probeInterval = setInterval(probeCapturableOnce, 1800);
  };
  const stopProbeLoop = () => {
    if (probeInterval) clearInterval(probeInterval);
    probeInterval = null;
  };
  startProbeLoop();

  // Stop polling once we see "ready" consistently; restart when tab/page likely changed.
  const _setReady = setReady;
  const setReadyWrapped = (p) => {
    _setReady(p);
    if (p?.status === 'ready') {
      stableReadyCount++;
      if (stableReadyCount >= 3) stopProbeLoop();
    } else if (p?.status !== 'unknown') {
      stableReadyCount = 0;
      startProbeLoop();
    }
  };
  // Replace local function reference used by probeCapturableOnce
  setReady = setReadyWrapped;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startProbeLoop();
  });

  // Refresh UI if storage updates (e.g. overlay/sidepanel sync).
  state.browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[K.CURRENT_LESSON]?.newValue) {
      state.currentLesson = changes[K.CURRENT_LESSON].newValue;
      applyLesson(state.currentLesson);
    }
  });

  state.browserAPI.runtime.onMessage.addListener((msg) => {
    if (msg.action === (A ? A.ASK_AI_ABOUT_TEXT : 'askAiAboutText')) {
      const chatTab = document.querySelector('.tab[data-tab="chat"]');
      if (chatTab) chatTab.click();
      import('./chat.js').then(({ submitQuery }) => {
        submitQuery(`Explain this text:\n\n"${msg.text}"`, false);
      });
    } else if (msg.action === (A ? A.CAPTURE_TEXT : 'captureText')) {
       // Apply immediately so we reset narration state, then auto-start.
       state.currentLesson = {
         title: 'Selected Text',
         content: msg.text || '',
         url: state.currentLesson?.url || '',
       };
       state.browserAPI.storage.local.set({ [K.CURRENT_LESSON]: state.currentLesson, [K.AUTO_PLAY_SELECTED_TEXT]: true });
       applyLesson(state.currentLesson);

       // Since it updates storage, we just switch to audio tab to play
       const audioTab = document.querySelector('.tab[data-tab="audio"]');
       if (audioTab) audioTab.click();

       if (audioCtrl && typeof audioCtrl.startPlayback === 'function') {
         audioCtrl.startPlayback();
       }
    }
  });

  // ── Summarization ────────────────────────────────────────────────────────
  const summarizeBtn = document.getElementById('summarize-btn');
  if (summarizeBtn) {
    summarizeBtn.addEventListener('click', () => {
      if (!state.currentLesson) return;
      // Switch to Chat tab
      const chatTab = document.querySelector('.tab[data-tab="chat"]');
      if (chatTab) chatTab.click();
      
      // Dynamic import to avoid circular dependency issues if any
      import('./chat.js').then(({ submitQuery }) => {
        submitQuery("Provide a concise bulleted summary of this text.", false);
      });
    });
  }

  // ── Text Search ──────────────────────────────────────────────────────────
  const contentSearch = document.getElementById('content-search');
  if (contentSearch) {
    contentSearch.addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      const lessonTextEl = document.getElementById('lesson-text');
      if (!lessonTextEl || !state.currentLesson) return;
      
      const children = Array.from(lessonTextEl.children);
      if (!term) {
        children.forEach(el => {
          el.style.display = '';
          clearMarks(el);
        });
        return;
      }

      children.forEach(el => {
        if (el.tagName === 'DIV' && !el.textContent.trim()) return; // Skip spacing divs
        
        // Handle ul elements differently to search their li children
        if (el.tagName === 'UL') {
          let hasMatch = false;
          Array.from(el.children).forEach(li => {
            if (li.textContent.toLowerCase().includes(term)) {
              li.style.display = '';
              hasMatch = true;
              clearMarks(li);
              markMatches(li, term);
            } else {
              li.style.display = 'none';
            }
          });
          el.style.display = hasMatch ? '' : 'none';
          return;
        }

        const text = el.textContent || '';
        if (text.toLowerCase().includes(term)) {
          el.style.display = '';
          clearMarks(el);
          markMatches(el, term);
        } else {
          el.style.display = 'none';
        }
      });
    });
  }
}

// ── Apply lesson to all tabs ───────────────────────────────────────────────
export function applyLesson(lesson) {
  if (!lesson) return;

  if (audioCtrl && typeof audioCtrl.resetNarrationForNewLesson === 'function') {
    audioCtrl.resetNarrationForNewLesson();
  }

  if (dom.urlEl) {
    try { dom.urlEl.textContent = new URL(lesson.url).hostname; }
    catch (_) { dom.urlEl.textContent = lesson.url || ''; }
  }
  if (dom.titleEl) dom.titleEl.textContent = lesson.title || 'Unnamed';
  if (dom.lessonHeader) dom.lessonHeader.style.display = 'block';

  if (dom.lessonText) {
    dom.lessonText.replaceChildren(mdToDomFragment(lesson.content || ''));
  }

  if (dom.exportInfo) {
    dom.exportInfo.textContent = `📖 "${lesson.title}" — ready to export.`;
  }

  if (dom.chatMessages) {
    const b = document.createElement('div');
    b.className = 'ai-bubble';
    b.appendChild(document.createTextNode('✅ Captured '));
    const strong = document.createElement('strong');
    strong.textContent = lesson.title || '';
    b.appendChild(strong);
    b.appendChild(document.createTextNode('. Ask me anything!'));
    dom.chatMessages.replaceChildren(b);
    state.chatHistory = []; // Reset conversation on new capture
  }
}
