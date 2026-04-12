// content.js

(function () {
  'use strict';

  const BTN_ID    = 'ai-study-companion-btn';
  const BTN_COLOR = 'rgba(109, 40, 217, 0.92)';

  // ── Inject button ─────────────────────────────────────────────────────────
  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) return;

    const btn = document.createElement('button');
    btn.id          = BTN_ID;
    btn.textContent = '✨ Capture Lesson';

    Object.assign(btn.style, {
      position:        'fixed',
      top:             '18px',
      right:           '22px',
      zIndex:          '2147483647',
      padding:         '11px 22px',
      borderRadius:    '50px',
      background:      BTN_COLOR,
      color:           '#ffffff',
      border:          '1.5px solid rgba(255,255,255,0.25)',
      cursor:          'pointer',
      fontWeight:      '700',
      fontSize:        '13px',
      letterSpacing:   '0.3px',
      backdropFilter:  'blur(14px)',
      webkitBackdropFilter: 'blur(14px)',
      boxShadow:       '0 6px 28px rgba(0,0,0,0.5)',
      transition:      'all .25s ease',
      fontFamily:      'system-ui, -apple-system, sans-serif',
      lineHeight:      '1',
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)';
      btn.style.boxShadow = '0 10px 36px rgba(109,40,217,0.6)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
      btn.style.boxShadow = '0 6px 28px rgba(0,0,0,0.5)';
    });

    btn.addEventListener('click', () => {
      btn.textContent         = '⏳ Scanning…';
      btn.style.background    = 'rgba(80,80,80,0.9)';
      btn.style.pointerEvents = 'none'; // prevent double-click
      try {
        chrome.runtime.sendMessage({ action: 'triggerDeepCapture' });
      } catch (e) {
        resetBtn(btn, false);
      }
    });

    document.body.appendChild(btn);
    console.log('[AI-Study] Capture button injected.');
  }

  function resetBtn(btn, success) {
    if (!btn) return;
    btn.style.pointerEvents = '';
    if (success === true) {
      btn.textContent      = '✅ Captured!';
      btn.style.background = 'rgba(34,197,94,0.9)';
    } else if (success === false) {
      btn.textContent      = '❌ No content found';
      btn.style.background = 'rgba(220,38,38,0.9)';
    }
    setTimeout(() => {
      if (!btn) return;
      btn.textContent      = '✨ Capture Lesson';
      btn.style.background = BTN_COLOR;
    }, 3000);
  }

  // ── Listen for background response ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureFinished') {
      resetBtn(document.getElementById(BTN_ID), msg.success);
    }
  });

  // ── Injection strategy ────────────────────────────────────────────────────
  // Try immediately, then on DOM ready, then poll for SPA nav changes
  injectButton();

  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', injectButton);
    window.addEventListener('load', injectButton);
  }

  // SPA (React Router) navigation watcher
  let _url = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== _url) {
      _url = location.href;
      document.getElementById(BTN_ID)?.remove();
      setTimeout(injectButton, 800); // slight delay for React to render body
    }
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });

})();
