// proxy.js — shared proxy-fetch handler for the extension background (Chrome importScripts + Firefox script chain).
(function initLexoraProxy(global) {
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_REQUEST_BODY_CHARS = 250_000;

  function pickAllowedHeaders(h) {
    const out = {};
    const src = h && typeof h === 'object' ? h : {};
    if (typeof src.Authorization === 'string') out.Authorization = src.Authorization;
    if (typeof src.authorization === 'string') out.Authorization = src.authorization;
    if (typeof src.Accept === 'string') out.Accept = src.Accept;
    if (typeof src.accept === 'string') out.Accept = src.accept;
    return out;
  }

  function isAllowedProxyUrl(u, getConfiguredChatEndpointUrl) {
    const configured = typeof getConfiguredChatEndpointUrl === 'function' ? getConfiguredChatEndpointUrl() : null;
    if (configured) {
      return u.origin === configured.origin;
    }
    const h = u.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  }

  /**
   * Read response body as text with a hard byte cap (streaming when possible).
   */
  async function readResponseTextCapped(response, maxBytes) {
    const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
    if (!reader) {
      const text = await response.text();
      if (text.length > maxBytes) throw new Error('Response too large.');
      return text;
    }
    const dec = new TextDecoder();
    let out = '';
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        total += value.byteLength;
        if (total > maxBytes) throw new Error('Response too large.');
        out += dec.decode(value, { stream: true });
      }
    }
    out += dec.decode();
    return out;
  }

  /**
   * @param {object} browserAPI chrome or browser namespace
   * @param {object} ctx
   * @param {object} ctx.request
   * @param {object} ctx.sender
   * @param {function} ctx.sendResponse
   * @param {function} ctx.isExtensionSender (sender) => boolean
   * @param {function} ctx.getConfiguredChatEndpointUrl () => URL | null
   */
  function handleProxyFetch(browserAPI, ctx) {
    const { request, sender, sendResponse, isExtensionSender, getConfiguredChatEndpointUrl } = ctx;

    if (!global.LexoraProtocol || typeof LexoraProtocol.isProxyFetchRequest !== 'function') {
      sendResponse({ success: false, error: 'Protocol unavailable.' });
      return false;
    }
    if (!LexoraProtocol.isProxyFetchRequest(request)) {
      sendResponse({ success: false, error: 'Invalid proxy request.' });
      return false;
    }
    if (!isExtensionSender(sender)) {
      sendResponse({ success: false, error: 'Unauthorized sender.' });
      return false;
    }

    let targetUrl;
    try {
      targetUrl = new URL(request.url);
    } catch (_) {
      sendResponse({ success: false, error: 'Invalid URL.' });
      return false;
    }
    if (!isAllowedProxyUrl(targetUrl, getConfiguredChatEndpointUrl)) {
      sendResponse({ success: false, error: 'Blocked URL (not in allowlist).' });
      return false;
    }

    const method = (request.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      sendResponse({ success: false, error: 'Blocked method.' });
      return false;
    }

    const bodyObj = request.body == null ? null : request.body;
    let bodyJson = undefined;
    if (bodyObj != null) {
      try {
        bodyJson = JSON.stringify(bodyObj);
      } catch (_) {
        sendResponse({ success: false, error: 'Invalid JSON body.' });
        return false;
      }
      if (bodyJson.length > MAX_REQUEST_BODY_CHARS) {
        sendResponse({ success: false, error: 'Request body too large.' });
        return false;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      ...pickAllowedHeaders(request.headers),
    };

    fetch(targetUrl.toString(), { method, headers, body: bodyJson })
      .then(async (r) => {
        const contentType = r.headers.get('content-type') || '';
        const text = await readResponseTextCapped(r, MAX_RESPONSE_BYTES);

        let data = null;
        let jsonOk = false;
        try {
          data = JSON.parse(text);
          jsonOk = true;
        } catch (_) {
          /* response may not be JSON */
        }

        if (!r.ok) {
          const error =
            (jsonOk && data && (data.error?.message || data.message)) || `HTTP ${r.status}`;
          throw Object.assign(new Error(String(error)), {
            __lexoraHttp: {
              ok: false,
              status: r.status,
              contentType,
              data: jsonOk ? data : null,
              __debugSnippet: global.DEBUG ? (text || '').slice(0, 800) : undefined,
            },
          });
        }

        if (!jsonOk) {
          throw Object.assign(new Error(`Non-JSON response (HTTP ${r.status}).`), {
            __lexoraHttp: {
              ok: true,
              status: r.status,
              contentType,
              __debugSnippet: global.DEBUG ? (text || '').slice(0, 800) : undefined,
            },
          });
        }

        return { data, meta: { ok: true, status: r.status, contentType } };
      })
      .then(({ data, meta }) => sendResponse({ success: true, data, meta }))
      .catch((err) => {
        const http = err && err.__lexoraHttp ? err.__lexoraHttp : null;
        sendResponse({ success: false, error: err?.message || String(err), http });
      });
    return true;
  }

  global.LexoraProxy = Object.freeze({
    handleProxyFetch,
    isAllowedProxyUrl,
    pickAllowedHeaders,
    MAX_RESPONSE_BYTES,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
