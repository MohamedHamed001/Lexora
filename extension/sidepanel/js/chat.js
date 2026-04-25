import { state } from './state.js';
import { dom } from './dom.js';
import { mdToHtml } from './utils.js';

export function addBubble(role, text) {
  const box = dom.chatMessages;
  const el  = document.createElement('div');
  el.className = role === 'user' ? 'user-bubble' : 'ai-bubble';
  el.innerText  = text;
  box.appendChild(el);
  dom.contentContainer.scrollTop = 99999;
  return el;
}

export function submitQuery(q, isHidden = false) {
  if (!isHidden) {
    addBubble('user', q);
  }
  
  if (!state.currentLesson) { addBubble('ai', '❌ Please capture a page first!'); return; }

  const headers = { 'Content-Type': 'application/json' };
  if (state.config.key) headers['Authorization'] = `Bearer ${state.config.key}`;

  // Append user turn to history
  state.chatHistory.push({ role: 'user', content: q });

  const thinking = addBubble('ai', '…');
  state.browserAPI.runtime.sendMessage({
    action: 'proxyFetch',
    url:    state.config.url,
    method: 'POST',
    headers: headers,
    body: {
      model: state.config.model,
      messages: [
        { role: 'system', content: `You are a concise study assistant. Answer based on this lesson:\n\nTitle: ${state.currentLesson.title}\n\n${state.currentLesson.content}` },
        ...state.chatHistory,
      ],
      temperature: 0.7,
    },
  }, resp => {
    if (resp?.success) {
      const reply = resp.data.choices[0].message.content;
      thinking.innerHTML = mdToHtml(reply);
      // Append assistant reply to history (keep last 20 turns to avoid token bloat)
      state.chatHistory.push({ role: 'assistant', content: reply });
      if (state.chatHistory.length > 40) state.chatHistory.splice(0, 2);
    } else {
      const errDetail = resp?.error || 'Could not reach API.';
      thinking.innerHTML = mdToHtml(
        `❌ **Chat error:** ${errDetail}\n\n` +
        `> Make sure your LLM endpoint is running (e.g. [LM Studio](http://lmstudio.ai) or [Ollama](https://ollama.com)) ` +
        `and the **Endpoint URL** in Settings matches your server.`
      );
      // Don't push failed turn into history
      state.chatHistory.pop();
    }
    dom.contentContainer.scrollTop = 99999;
  });
}

export function initChat() {
  if (!dom.chatInput) return;

  dom.chatInput.addEventListener('keypress', (e) => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const q = e.target.value.trim();
    e.target.value = '';
    submitQuery(q);
  });
}
