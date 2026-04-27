import { state } from './state.js';
import { dom } from './dom.js';
import { mdToHtml, escHtml } from './utils.js';

function showNoSupportedContent(message) {
  const msg = (message || 'No content found on this page.').trim();

  if (dom.lessonHeader) dom.lessonHeader.style.display = 'none';
  if (dom.titleEl) dom.titleEl.textContent = '';

  if (dom.lessonText) {
    dom.lessonText.innerHTML = `
      <div class="no-content-card">
        <div class="no-content-title">No supported content detected</div>
        <div class="no-content-body">
          ${escHtml(msg)}
          <br><br>
          If you’re sure the page contains readable content, wait a moment (large files can take time), then refresh once and try capturing again.
        </div>
      </div>
    `.trim();
  }

  if (dom.exportInfo) {
    dom.exportInfo.textContent = 'No lesson captured yet.';
  }

  if (dom.chatMessages) {
    dom.chatMessages.innerHTML = `<div class="ai-bubble">⚠️ ${escHtml(msg)}<br><br>Try capturing again after the page finishes loading.</div>`;
    state.chatHistory = [];
  }

  const contentTab = document.querySelector('.tab[data-tab="content"]');
  if (contentTab) contentTab.click();
}

export function initUI() {
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

      state.browserAPI.runtime.sendMessage({ action: 'triggerDeepCapture' }, (resp) => {
        dom.captureBtn.disabled = false;

        if (resp && resp.success) {
          state.currentLesson = resp.data;
          state.browserAPI.storage.local.set({ currentLesson: state.currentLesson });
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
  const setReady = ({ status, reason }) => {
    if (!dom.captureReady) return;
    dom.captureReady.classList.remove(
      'capture-ready--unknown',
      'capture-ready--ready',
      'capture-ready--not_ready',
      'capture-ready--restricted'
    );

    const s = status || 'unknown';
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
    dom.captureReady.title = reason || 'Checking page…';
  };

  async function probeCapturableOnce() {
    setReady({ status: 'unknown', reason: 'Checking page…' });
    try {
      // Support both callback-style (chrome) and promise-style (browser) APIs.
      const maybePromise = state.browserAPI.runtime.sendMessage({ action: 'probeCapturable' }, (resp) => {
        if (resp?.success) setReady({ status: resp.status, reason: resp.reason });
        else setReady({ status: 'unknown', reason: resp?.error || 'Checking page…' });
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        const resp = await maybePromise;
        if (resp?.success) setReady({ status: resp.status, reason: resp.reason });
        else setReady({ status: 'unknown', reason: resp?.error || 'Checking page…' });
      }
    } catch (e) {
      setReady({ status: 'restricted', reason: e?.message || 'This page blocks extraction.' });
    }
  }

  // Kick off immediately, then refresh periodically (captures SPA/PDF viewer readiness).
  probeCapturableOnce();
  setInterval(probeCapturableOnce, 1800);

  // Refresh UI if storage updates (e.g. overlay/sidepanel sync).
  state.browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.currentLesson?.newValue) {
      state.currentLesson = changes.currentLesson.newValue;
      applyLesson(state.currentLesson);
    }
  });

  state.browserAPI.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'askAiAboutText') {
      const chatTab = document.querySelector('.tab[data-tab="chat"]');
      if (chatTab) chatTab.click();
      import('./chat.js').then(({ submitQuery }) => {
        submitQuery(`Explain this text:\n\n"${msg.text}"`, false);
      });
    } else if (msg.action === 'captureText') {
       // Apply immediately so we reset narration state, then auto-start.
       state.currentLesson = {
         title: 'Selected Text',
         content: msg.text || '',
         url: state.currentLesson?.url || '',
       };
       state.browserAPI.storage.local.set({ currentLesson: state.currentLesson, autoPlaySelectedText: true });
       applyLesson(state.currentLesson);

       // Since it updates storage, we just switch to audio tab to play
       const audioTab = document.querySelector('.tab[data-tab="audio"]');
       if (audioTab) audioTab.click();

       if (window.lexoraAudio && typeof window.lexoraAudio.startPlayback === 'function') {
         window.lexoraAudio.startPlayback();
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
          el.innerHTML = el.innerHTML.replace(/<mark>([^<]+)<\/mark>/gi, '$1');
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
              let html = li.innerHTML.replace(/<mark>([^<]+)<\/mark>/gi, '$1');
              const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})`, 'gi');
              li.innerHTML = html.replace(regex, '<mark>$1</mark>');
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
          let html = el.innerHTML.replace(/<mark>([^<]+)<\/mark>/gi, '$1');
          const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})`, 'gi');
          el.innerHTML = html.replace(regex, '<mark>$1</mark>');
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

  if (window.lexoraAudio && typeof window.lexoraAudio.resetNarrationForNewLesson === 'function') {
    window.lexoraAudio.resetNarrationForNewLesson();
  }

  if (dom.urlEl) {
    try { dom.urlEl.textContent = new URL(lesson.url).hostname; }
    catch (_) { dom.urlEl.textContent = lesson.url || ''; }
  }
  if (dom.titleEl) dom.titleEl.textContent = lesson.title || 'Unnamed';
  if (dom.lessonHeader) dom.lessonHeader.style.display = 'block';

  if (dom.lessonText) {
    dom.lessonText.innerHTML = mdToHtml(lesson.content || '');
  }

  if (dom.exportInfo) {
    dom.exportInfo.textContent = `📖 "${lesson.title}" — ready to export.`;
  }

  if (dom.chatMessages) {
    dom.chatMessages.innerHTML = `<div class="ai-bubble">✅ Captured <strong>${escHtml(lesson.title)}</strong>. Ask me anything!</div>`;
    state.chatHistory = []; // Reset conversation on new capture
  }
}
