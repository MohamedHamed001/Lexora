// In-page overlay (Shadow DOM + MessageChannel to sidepanel). Factory returns overlay API.
(function (global) {
  global.LexoraContentCreateOverlay = function LexoraContentCreateOverlay(browserAPI) {
  let overlayHost = null;
  let overlayShadow = null;
  let overlayIframe = null;
  /** @type {((e: MouseEvent) => void) | null} */
  let overlayMoveHandler = null;
  /** @type {(() => void) | null} */
  let overlayUpHandler = null;
  /** @type {MessagePort | null} */
  let overlayControlPort = null;
  let overlayHandshakeToken = null;
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  function getExtensionOrigin() {
    try {
      return new URL(browserAPI.runtime.getURL('')).origin;
    } catch (_) {
      return null;
    }
  }

  function destroyOverlay() {
    if (overlayMoveHandler) {
      window.removeEventListener('mousemove', overlayMoveHandler);
      overlayMoveHandler = null;
    }
    if (overlayUpHandler) {
      window.removeEventListener('mouseup', overlayUpHandler);
      overlayUpHandler = null;
    }
    // Best-effort teardown: the page may have already unloaded the iframe
    // or detached the host. Surface any unexpected errors via debugLog.
    try {
      if (overlayIframe) overlayIframe.src = 'about:blank';
    } catch (err) {
      if (typeof globalThis.debugLog === 'function') {
        globalThis.debugLog('Overlay', 'iframe src reset failed', err);
      }
    }
    try {
      if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    } catch (err) {
      if (typeof globalThis.debugLog === 'function') {
        globalThis.debugLog('Overlay', 'overlay removal failed', err);
      }
    }
    try {
      overlayControlPort?.close();
    } catch (_) { /* ignore */ }
    overlayControlPort = null;
    overlayHandshakeToken = null;
    overlayHost = null;
    overlayShadow = null;
    overlayIframe = null;
    isMinimized = false;
    isDragging = false;
  }

  function createOverlay() {
    if (overlayHost) return;
    if (window !== window.top) return;

    const extensionOrigin = getExtensionOrigin();

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
      :host { all: initial; }
      .wrapper { position: relative; width: 100%; height: 100%; background: #1a1a1a; background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); border: 1px solid rgba(255,255,255,0.1); border-radius: inherit; overflow: hidden; display: flex; flex-direction: column; transition: all 0.4s ease; }
      .overlay-header { height: 32px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid rgba(255,255,255,0.1); user-select: none; cursor: move; }
      .overlay-title { color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; pointer-events: none; }
      .nav-controls { display: flex; gap: 6px; }
      iframe { flex: 1; width: 100%; border: none; background: transparent; transition: opacity 0.3s; }
      .control-btn { width: 20px; height: 20px; background: rgba(255,255,255,0.1); border: none; border-radius: 4px; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; transition: all 0.2s; }
      .control-btn:hover { background: rgba(255,255,255,0.2); }
      .close-btn:hover { background: rgba(239, 68, 68, 0.8); }
      
      /* Minimized State */
      .minimized-gem { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; gap: 4px; padding: 0 8px; box-sizing: border-box; background: linear-gradient(135deg, #6d28d9 0%, #4f46e5 100%); cursor: grab; color: white; box-shadow: 0 0 20px rgba(109, 40, 217, 0.5); animation: gemPulse 2s infinite ease-in-out; }
      .mini-audio-btn { flex: 0 0 auto; width: 36px; height: 36px; border: none; border-radius: 10px; background: rgba(255,255,255,0.18); color: white; font-size: 15px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.15s; }
      .mini-audio-btn:hover { background: rgba(255,255,255,0.32); }
      .mini-audio-btn:active { transform: scale(0.96); }
      .mini-expand-btn { flex: 0 0 auto; width: 32px; height: 32px; border: none; border-radius: 50%; background: rgba(255,255,255,0.22); color: white; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-left: 2px; }
      .mini-expand-btn:hover { background: rgba(255,255,255,0.35); }
      @keyframes gemPulse { 0%, 100% { transform: scale(1); box-shadow: 0 0 15px rgba(109, 40, 217, 0.4); } 50% { transform: scale(1.05); box-shadow: 0 0 25px rgba(109, 40, 217, 0.7); } }
      
      .drag-cover { position: absolute; inset: 0; z-index: 10; display: none; cursor: move; }
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';

    const dragCover = document.createElement('div');
    dragCover.className = 'drag-cover';

    const gem = document.createElement('div');
    gem.className = 'minimized-gem';
    let gemDragStartPos = null;
    overlayHandshakeToken =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    function postToSidepanel(action) {
      if (!extensionOrigin || !overlayHandshakeToken) return;
      try {
        if (overlayControlPort) {
          overlayControlPort.postMessage({
            type: 'lexora',
            action,
            token: overlayHandshakeToken,
          });
          return;
        }
      } catch (err) {
        if (typeof globalThis.debugLog === 'function') {
          globalThis.debugLog('Overlay', 'control port postMessage failed', err);
        }
      }
    }

    function makeMiniBtn(label, title, action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-audio-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); postToSidepanel(action); });
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('mouseup', (e) => e.stopPropagation());
      return b;
    }

    const miniPrev = makeMiniBtn('⏮', 'Previous sentence', 'prev');
    const miniPlay = makeMiniBtn('▶', 'Play / Pause', 'play-toggle');
    miniPlay.classList.add('mini-play-btn');
    const miniNext = makeMiniBtn('⏭', 'Next sentence', 'next');

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'mini-expand-btn';
    expandBtn.textContent = '⛶';
    expandBtn.title = 'Expand panel';
    expandBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); setMinimized(false); });
    expandBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    expandBtn.addEventListener('mouseup', (e) => e.stopPropagation());

    gem.appendChild(miniPrev);
    gem.appendChild(miniPlay);
    gem.appendChild(miniNext);
    gem.appendChild(expandBtn);

    gem.onmousedown = (e) => {
      if (e.target.closest('button')) return;
      gemDragStartPos = { x: e.clientX, y: e.clientY };
      isDragging = true;
      const rect = overlayHost.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlayHost.style.transition = 'none';
      e.preventDefault();
    };

    gem.onmouseup = (e) => {
      if (e.target.closest('button')) return;
      if (!gemDragStartPos) return;
      const dx = Math.abs(e.clientX - gemDragStartPos.x);
      const dy = Math.abs(e.clientY - gemDragStartPos.y);
      gemDragStartPos = null;
      if (dx < 5 && dy < 5) setMinimized(false);
    };

    const header = document.createElement('div');
    header.className = 'overlay-header';
    
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Lexora';

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
    closeBtn.onclick = (e) => { e.stopPropagation(); destroyOverlay(); };

    controls.appendChild(minBtn);
    controls.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(controls);

    overlayIframe = document.createElement('iframe');
    overlayIframe.src = browserAPI.runtime.getURL('sidepanel/sidepanel.html');
    overlayIframe.allow = 'autoplay; clipboard-write';
    // MessageChannel: port is transferred in handshake so host page JS cannot
    // forge controls (postMessage from page never includes our MessagePort).
    overlayIframe.addEventListener('load', () => {
      if (!extensionOrigin || !overlayHandshakeToken || !overlayIframe.contentWindow) return;
      try {
        const ch = new globalThis.MessageChannel();
        overlayControlPort = ch.port1;
        overlayControlPort.onmessage = (ev) => {
          if (!ev.data || ev.data.type !== 'lexora-ui') return;
          if (ev.data.token !== overlayHandshakeToken) return;
          const g = ev.data.playGlyph;
          if (g && miniPlay) miniPlay.textContent = g;
        };
        overlayIframe.contentWindow.postMessage(
          { type: 'lexora-port-handshake', token: overlayHandshakeToken },
          extensionOrigin,
          [ch.port2]
        );
        postToSidepanel('init');
      } catch (err) {
        if (typeof globalThis.debugLog === 'function') {
          globalThis.debugLog('Overlay', 'MessageChannel handshake failed', err);
        }
      }
    });

    header.onmousedown = (e) => {
      if (e.target.closest('.control-btn')) return;
      isDragging = true;
      dragCover.style.display = 'block';
      const rect = overlayHost.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlayHost.style.transition = 'none';
      e.preventDefault();
    };

    overlayMoveHandler = (e) => {
      if (!isDragging || !overlayHost) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      const minW = isMinimized ? 220 : 420;
      const minH = isMinimized ? 52 : 600;
      const clampedX = Math.max(0, Math.min(window.innerWidth - minW, x));
      const clampedY = Math.max(0, Math.min(window.innerHeight - minH, y));
      overlayHost.style.left = clampedX + 'px';
      overlayHost.style.top = clampedY + 'px';
      overlayHost.style.right = 'auto';
    };
    overlayUpHandler = () => {
      if (!isDragging || !overlayHost) return;
      isDragging = false;
      dragCover.style.display = 'none';
      overlayHost.style.transition =
        'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, width 0.4s ease, height 0.4s ease, border-radius 0.4s ease';
    };
    window.addEventListener('mousemove', overlayMoveHandler);
    window.addEventListener('mouseup', overlayUpHandler);

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
      overlayHost.style.width = '220px';
      overlayHost.style.height = '52px';
      overlayHost.style.borderRadius = '26px';
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
    if (window !== window.top) return;
    if (overlayHost && !overlayHost.isConnected) destroyOverlay();
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

  return { createOverlay, destroyOverlay, toggleOverlay, setMinimized, get isDragging() { return isDragging; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
