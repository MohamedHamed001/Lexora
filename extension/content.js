// content.js
// Responsible for injecting page elements and capturing content.

(function () {
  'use strict';

  const BTN_ID    = 'ai-study-companion-btn';
  const BTN_COLOR = 'rgba(109, 40, 217, 0.92)';

  // ── Overlay Injection Logic ──────────────────────────────────────────────
  let overlayHost = null;
  let overlayShadow = null;
  let overlayIframe = null;
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  function createOverlay() {
    if (overlayHost) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'lexora-overlay-root';
    overlayHost.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 420px;
      height: 600px;
      z-index: 2147483647;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, width 0.4s ease, height 0.4s ease, border-radius 0.4s ease;
      transform: translateX(450px);
      opacity: 0;
      pointer-events: none;
      box-shadow: 0 12px 40px rgba(0,0,0,0.3);
      border-radius: 12px;
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    overlayShadow = overlayHost.attachShadow({ mode: 'closed' });

    // Styles for the shadow root
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
      }
      .wrapper {
        position: relative;
        width: 100%;
        height: 100%;
        background: #1a1a1a;
        background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: inherit;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: all 0.4s ease;
      }
      .overlay-header {
        height: 32px;
        background: rgba(255,255,255,0.05);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        user-select: none;
        cursor: move;
      }
      .overlay-title {
        color: rgba(255,255,255,0.5);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        pointer-events: none;
      }
      .nav-controls {
        display: flex;
        gap: 6px;
      }
      iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: transparent;
        transition: opacity 0.3s;
      }
      .control-btn {
        width: 20px;
        height: 20px;
        background: rgba(255,255,255,0.1);
        border: none;
        border-radius: 4px;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: bold;
        transition: all 0.2s;
      }
      .control-btn:hover {
        background: rgba(255,255,255,0.2);
      }
      .close-btn:hover {
        background: rgba(239, 68, 68, 0.8);
      }
      
      /* Minimized State */
      .minimized-gem {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #6d28d9 0%, #4f46e5 100%);
        cursor: pointer;
        font-size: 24px;
        color: white;
        box-shadow: 0 0 20px rgba(109, 40, 217, 0.5);
        animation: gemPulse 2s infinite ease-in-out;
      }
      @keyframes gemPulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 15px rgba(109, 40, 217, 0.4); }
        50% { transform: scale(1.05); box-shadow: 0 0 25px rgba(109, 40, 217, 0.7); }
      }
      
      /* Cover to prevent iframe from stealing mouse events during drag */
      .drag-cover {
        position: absolute;
        inset: 0;
        z-index: 10;
        display: none;
        cursor: move;
      }
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';

    const dragCover = document.createElement('div');
    dragCover.className = 'drag-cover';

    const gem = document.createElement('div');
    gem.className = 'minimized-gem';
    gem.innerHTML = '✦';
    gem.onclick = () => setMinimized(false);

    const header = document.createElement('div');
    header.className = 'overlay-header';
    
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Lexora Companion';

    const controls = document.createElement('div');
    controls.className = 'nav-controls';

    const minBtn = document.createElement('button');
    minBtn.className = 'control-btn';
    minBtn.innerHTML = '−';
    minBtn.title = 'Minimize (Keep Playing)';
    minBtn.onclick = (e) => { e.stopPropagation(); setMinimized(true); };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'control-btn close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.title = 'Close & Stop';
    closeBtn.onclick = (e) => { 
      e.stopPropagation();
      if (overlayIframe && overlayIframe.contentWindow) {
        overlayIframe.src = 'about:blank';
      }
      toggleOverlay(false); 
      setTimeout(() => {
        if (overlayIframe) overlayIframe.src = chrome.runtime.getURL('sidepanel/sidepanel.html');
      }, 500);
    };

    controls.appendChild(minBtn);
    controls.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(controls);

    overlayIframe = document.createElement('iframe');
    overlayIframe.src = chrome.runtime.getURL('sidepanel/sidepanel.html');
    overlayIframe.allow = "autoplay; clipboard-write";

    // ── Drag Logic ──────────────────────────────────────────────────────────
    header.onmousedown = (e) => {
      // Don't start dragging if we're clicking a control button
      if (e.target.closest('.control-btn')) return;

      isDragging = true;
      dragCover.style.display = 'block';
      const rect = overlayHost.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlayHost.style.transition = 'none';
      e.preventDefault();
    };

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      
      const clampedX = Math.max(0, Math.min(window.innerWidth - (isMinimized ? 64 : 420), x));
      const clampedY = Math.max(0, Math.min(window.innerHeight - (isMinimized ? 64 : 600), y));
      
      overlayHost.style.left = clampedX + 'px';
      overlayHost.style.top = clampedY + 'px';
      overlayHost.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        dragCover.style.display = 'none';
        overlayHost.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, width 0.4s ease, height 0.4s ease, border-radius 0.4s ease';
      }
    });

    wrapper.appendChild(header);
    wrapper.appendChild(overlayIframe);
    wrapper.appendChild(gem);
    wrapper.appendChild(dragCover);
    overlayShadow.appendChild(style);
    overlayShadow.appendChild(wrapper);

    document.body.appendChild(overlayHost);
  }

  function setMinimized(min) {
    if (!overlayHost) return;
    isMinimized = min;
    
    if (min) {
      overlayHost.style.width = '64px';
      overlayHost.style.height = '64px';
      overlayHost.style.borderRadius = '32px';
      overlayShadow.querySelector('.minimized-gem').style.display = 'flex';
      overlayIframe.style.opacity = '0';
      overlayIframe.style.pointerEvents = 'none';
      overlayShadow.querySelector('.overlay-header').style.display = 'none';
    } else {
      overlayHost.style.width = '420px';
      overlayHost.style.height = '600px';
      overlayHost.style.borderRadius = '12px';
      overlayShadow.querySelector('.minimized-gem').style.display = 'none';
      overlayIframe.style.opacity = '1';
      overlayIframe.style.pointerEvents = 'auto';
      overlayShadow.querySelector('.overlay-header').style.display = 'flex';
    }
  }

  function toggleOverlay(force) {
    if (!overlayHost) createOverlay();
    
    const isVisible = overlayHost.style.opacity === '1';
    const shouldShow = force !== undefined ? force : !isVisible;

    if (shouldShow) {
      overlayHost.style.transform = 'translateX(0)';
      overlayHost.style.opacity = '1';
      overlayHost.style.pointerEvents = 'auto';
      if (!overlayHost.style.left) {
        overlayHost.style.right = '20px';
        overlayHost.style.top = '20px';
      }
    } else {
      overlayHost.style.transform = 'translateX(500px)';
      overlayHost.style.opacity = '0';
      overlayHost.style.pointerEvents = 'none';
    }
  }

  // ── Listen for messages ──────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureFinished' && overlayHost) {
      // Forward to iframe if needed, or handle locally
    } else if (msg.action === 'toggleOverlay') {
      toggleOverlay();
    }
  });

  let _url = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== _url) {
      _url = location.href;
    }
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });

})();
