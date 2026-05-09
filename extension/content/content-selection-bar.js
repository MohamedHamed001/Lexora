// Selection floating actions (Read / Ask AI). Call LexoraContentInitSelectionBar(browserAPI, Overlay).
(function initLexoraContentSelectionBar(global) {
  global.LexoraContentInitSelectionBar = function LexoraContentInitSelectionBar(browserAPI, Overlay) {
    let barHost = null;
    let bar = null;

    function targetInsideBar(ev) {
      return bar && ev.composedPath().includes(bar);
    }

    function create() {
      barHost = document.createElement('div');
      barHost.id = 'lexora-selection-host';
      barHost.style.cssText =
        'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;';
      const root = barHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        .bar { position: absolute; display: none; gap: 4px; align-items: center; flex-wrap: wrap;
          background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
          padding: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          font-family: system-ui, -apple-system, sans-serif; pointer-events: auto; }
        button { background: rgba(255,255,255,0.1); color: white; border: none; border-radius: 4px;
          padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.2s; }
        button:hover { background: rgba(255,255,255,0.2); }
      `;
      bar = document.createElement('div');
      bar.className = 'bar';

      const readBtn = document.createElement('button');
      readBtn.type = 'button';
      readBtn.textContent = '🔊 Read';
      readBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        browserAPI.runtime.sendMessage({ action: 'captureText', text: window.getSelection().toString() });
        bar.style.display = 'none';
        Overlay.toggleOverlay(true);
      };

      const askBtn = document.createElement('button');
      askBtn.type = 'button';
      askBtn.textContent = '✨ Ask AI';
      askBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        browserAPI.runtime.sendMessage({ action: 'askAiAboutText', text: window.getSelection().toString() });
        bar.style.display = 'none';
        Overlay.toggleOverlay(true);
      };

      bar.appendChild(readBtn);
      bar.appendChild(askBtn);
      root.appendChild(style);
      root.appendChild(bar);
      document.body.appendChild(barHost);
    }

    function initListeners() {
      document.addEventListener('mouseup', (e) => {
        if (!barHost) create();
        if (targetInsideBar(e)) return;
        setTimeout(() => {
          const selection = window.getSelection();
          const text = selection.toString().trim();
          if (text.length > 0 && !Overlay.isDragging && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            bar.style.display = 'flex';
            const top = window.scrollY + rect.top - bar.offsetHeight - 8;
            const left = window.scrollX + rect.left + rect.width / 2 - bar.offsetWidth / 2;
            bar.style.top = Math.max(window.scrollY + 8, top) + 'px';
            bar.style.left = Math.max(8, left) + 'px';
          } else {
            bar.style.display = 'none';
          }
        }, 10);
      });

      document.addEventListener('selectionchange', () => {
        if (bar && window.getSelection().toString().trim() === '') {
          bar.style.display = 'none';
        }
      });
    }

    initListeners();
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
