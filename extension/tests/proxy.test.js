import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

async function loadLexoraProxy() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const prot = await fs.readFile(path.join(process.cwd(), 'extension/protocol.js'), 'utf8');
  const prox = await fs.readFile(path.join(process.cwd(), 'extension/proxy.js'), 'utf8');
  const run = new Function(`${prot}\n${prox}\nreturn globalThis.LexoraProxy;`);
  return run();
}

describe('proxy.js', () => {
  let fetchSnapshot;

  beforeEach(() => {
    fetchSnapshot = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = fetchSnapshot;
    vi.restoreAllMocks();
  });

  test('rejects JSON responses larger than cap (streaming)', async () => {
    const LexoraProxy = await loadLexoraProxy();
    const sendResponse = vi.fn();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        body: {
          getReader() {
            let once = false;
            return {
              read() {
                if (once) return Promise.resolve({ done: true, value: undefined });
                once = true;
                const big = new Uint8Array(LexoraProxy.MAX_RESPONSE_BYTES + 1);
                return Promise.resolve({ done: false, value: big });
              },
            };
          },
        },
      })
    );

    globalThis.LexoraProtocol = {
      isProxyFetchRequest: (m) =>
        !!m && m.action === 'proxyFetch' && typeof m.url === 'string',
    };

    LexoraProxy.handleProxyFetch({}, {
      request: { action: 'proxyFetch', url: 'http://127.0.0.1/x', method: 'POST', body: {} },
      sender: { url: 'chrome-extension://abc/sidepanel/sidepanel.html' },
      sendResponse,
      isExtensionSender: () => true,
      getConfiguredChatEndpointUrl: () => null,
    });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const arg = sendResponse.mock.calls[0][0];
    expect(arg.success).toBe(false);
    expect(String(arg.error)).toMatch(/too large/i);
  });

  test('allows ::1 in allowlist when no configured endpoint', async () => {
    const LexoraProxy = await loadLexoraProxy();
    expect(LexoraProxy.isAllowedProxyUrl(new URL('http://[::1]:8080/api'), () => null)).toBe(true);
  });
});
